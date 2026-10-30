import { afterEach, describe, expect, it, vi } from "vitest";
import type { Express, RequestHandler } from "express";
import { MemoryPluginStore } from "./store";
import { mountPluginApi } from "./routes";
import { LiveCallRegistry, LIVE_RETENTION_MS } from "./liveSessions";
import type { LiveCallSender } from "./liveCalls";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";
import { CONFIRM_TTL_MS } from "./tokens";
import { DEFAULT_PLUGIN_SCOPES, mintScopesCompatible, isWritePluginScope } from "./scopes";
import { createSqlPluginStore } from "./sqlStore";
import { OPERATOR_SLUG, operatorMaxDurationSec, parseOperatorPayload } from "./operatorLine";
import { siAssistantNumber } from "./siAssistantConstants";
import { bindPluginStore } from "./bindings";
import { setOutboundToolStoreForTests, OPT_OUT_TOOL_NAME } from "../tools/outboundTools";
import { getTool } from "../tools/registry";
import twilio from "twilio";
import { CallSessionRegistry } from "../runtime/sessionRegistry";
import { handleOutboundAnswer, handleOutboundStatus } from "../runtime/outbound/outboundWebhook";
import { operatorLinePolicy } from "../agents/operatorLineAgent";
import { enabledCampaigns } from "../runtime/outbound/scheduler";

const PHONE = "+19094795435";
const OPEN = "2026-10-22T18:00:00Z";
const INPUT = { phone: PHONE, purpose: "Arrange a synthetic family booking. Preserve flashes, but no vision loss." };
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
    OPERATOR_LINE_INBOUND_ENABLED: "true", PLUGIN_WRITES_ENABLED: "true", RUNTIME_OUTBOUND_DIALING: "1", OUTBOUND_CAMPAIGN_SI_ASSISTANT: "1",
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

describe("operator scenario pre-approval", () => {
  it("keeps valid scenarios pending while the toggle is OFF", async () => {
    const h = await boot();
    expect(await h.store.getOperatorScenarioPreapprovalEnabled()).toBe(false);
    const prepared = await h.request("/prepare_operator_call", { phone: PHONE, scenario_id: "A1" });
    expect(prepared).toMatchObject({ status: 201, body: { status: "pending_approval", approval: { status: "pending" } } });
    expect(prepared.body.confirmToken).toBeUndefined();
    expect(await h.store.getApproval(prepared.body.approval.id)).toMatchObject({ approvedBy: null, approvedAt: null, approvalMetadata: null });
    expect((await h.request("/commit_call_live", {})).status).toBe(400);
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it.each(Array.from({ length: 10 }, (_, index) => `A${index + 1}`))("pre-approves %s with audit and permits one bot commit when ON", async (scenario_id) => {
    const h = await boot();
    await h.store.setOperatorScenarioPreapprovalEnabled(true, "staff-id");
    h.clock.at = new Date("2026-11-01T08:00:00Z"); // Outside patient dialing hours.
    h.env.OUTBOUND_DAILY_CAP = "0";
    const prepared = await h.request("/prepare_operator_call", { phone: PHONE, scenario_id });
    expect(prepared).toMatchObject({ status: 201, body: { status: "approved", approval: {
      status: "approved", approvedBy: "scenario_preapproval", approvalMetadata: { scenario_id },
    } } });
    const id = prepared.body.approval.id;
    expect(await h.store.getApproval(id)).toMatchObject({
      approvedBy: "scenario_preapproval", approvedAt: h.clock.at, approvalMetadata: { scenario_id },
      payload: { callKind: "operator", scenario_id, initiated_by: "bot_initiative" },
    });
    expect(h.bot.scopes).not.toContain("contacts:approve");
    expect((await h.request(`/approvals/${id}/approve`, {}, h.bot)).status).toBe(403);
    const confirmToken = prepared.body.confirmToken;
    const result = await h.request("/commit_call_live", { confirmToken });
    expect(result).toMatchObject({ status: 200, body: { status: "live" } });
    expect(h.sessions.get(result.body.sessionId)?.operatorCall?.scenario_id).toBe(scenario_id);
    expect(await h.store.getApproval(id)).toMatchObject({ status: "committed", approvedBy: "scenario_preapproval", approvalMetadata: { scenario_id } });
    expect((await h.request("/commit_call_live", { confirmToken })).status).toBe(409);
    expect(h.sender.createCall).toHaveBeenCalledOnce();
    const audit = JSON.stringify(await h.store.listAudit());
    for (const secret of [PHONE, confirmToken, h.bot.plaintext]) expect(audit).not.toContain(secret);
  });

  it("keeps free-text and patient/SI approvals pending when ON", async () => {
    const h = await boot();
    await h.store.setOperatorScenarioPreapprovalEnabled(true, "staff-id");
    const freeText = await h.request("/prepare_operator_call", INPUT);
    expect(freeText).toMatchObject({ status: 201, body: { status: "pending_approval" } });
    expect(freeText.body.confirmToken).toBeUndefined();
    const patientBot = h.store.mint(["contacts:prepare", "contacts:commit"]);
    const patient = await h.request("/prepare_call", { phone: PHONE, dateOfBirth: "1950-03-17", purpose: "Synthetic test", scenario_id: "A1" }, patientBot);
    expect(patient).toMatchObject({ status: 201, body: { status: "pending_approval", approval: { status: "pending" } } });
    expect(await h.store.getApproval(patient.body.approval.id)).toMatchObject({ approvedBy: null, approvalMetadata: null });
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it.each(["A0", "A11", "a1", "", 1])("rejects invalid scenario %s when ON", async (scenario_id) => {
    const h = await boot();
    await h.store.setOperatorScenarioPreapprovalEnabled(true, "staff-id");
    expect((await h.request("/prepare_operator_call", { phone: PHONE, scenario_id })).status).toBe(400);
    expect(await h.store.listApprovals()).toEqual([]);
  });

  it("treats a settings read failure as OFF during prepare", async () => {
    const h = await boot();
    await h.store.setOperatorScenarioPreapprovalEnabled(true, "staff-id");
    vi.spyOn(h.store, "getOperatorScenarioPreapprovalEnabled").mockRejectedValue(new Error("private"));
    const prepared = await h.request("/prepare_operator_call", { phone: PHONE, scenario_id: "A1" });
    expect(prepared).toMatchObject({ status: 201, body: { status: "pending_approval" } });
    expect(prepared.body.confirmToken).toBeUndefined();
    expect(await h.store.getApproval(prepared.body.approval.id)).toMatchObject({ approvedBy: null, approvalMetadata: null });
  });

  it.each(["off", "unreadable"])("blocks an automatic commit when the setting becomes %s", async (mode) => {
    const h = await boot();
    await h.store.setOperatorScenarioPreapprovalEnabled(true, "staff-id");
    const prepared = await h.request("/prepare_operator_call", { phone: PHONE, scenario_id: "A1" });
    if (mode === "off") await h.store.setOperatorScenarioPreapprovalEnabled(false, "staff-id");
    else vi.spyOn(h.store, "getOperatorScenarioPreapprovalEnabled").mockRejectedValue(new Error("private"));
    expect((await h.request("/commit_call_live", { confirmToken: prepared.body.confirmToken })).status).toBe(503);
    expect((await h.store.getApproval(prepared.body.approval.id))?.confirmUsedAt).toBeNull();
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("rechecks pre-approval immediately before dialing", async () => {
    const h = await boot();
    await h.store.setOperatorScenarioPreapprovalEnabled(true, "staff-id");
    const prepared = await h.request("/prepare_operator_call", { phone: PHONE, scenario_id: "A1" });
    const persist = h.store.saveOperatorCall.bind(h.store);
    vi.spyOn(h.store, "saveOperatorCall").mockImplementation(async (record) => {
      await persist(record);
      await h.store.setOperatorScenarioPreapprovalEnabled(false, "staff-id");
    });
    expect((await h.request("/commit_call_live", { confirmToken: prepared.body.confirmToken })).body).toMatchObject({
      error: "Call was not placed: operator_scenario_preapproval_disabled", outcome: "not_sent",
    });
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it.each(["voice", "sms", "operator", "international"])("honors %s opt-outs at prepare and after pre-approval", async (kind) => {
    const h = await boot();
    await h.store.setOperatorScenarioPreapprovalEnabled(true, "staff-id");
    const phone = kind === "international" ? "+442079460123" : PHONE;
    const input = { phone, scenario_id: "A1" };
    const prepared = await h.request("/prepare_operator_call", input);
    if (kind === "voice") await h.outbound.stampDoNotContact(phone, "voice");
    else if (kind === "sms") await h.store.setSmsOptOut(phone.slice(-10), true);
    else await h.store.setOperatorOptOut(phone);
    expect(await h.request("/prepare_operator_call", input)).toMatchObject({ status: 409, body: { outcome: "not_sent" } });
    expect(await h.store.listApprovals()).toHaveLength(1);
    expect(await h.request("/commit_call_live", { confirmToken: prepared.body.confirmToken })).toMatchObject({ status: 409, body: { outcome: "not_sent" } });
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });
});

describe("open Wayne operator line with provenance-based outbound approval", () => {
  it.each(["switch", "env", "storage"])("refuses preparation and previously approved outbound calls when disabled by %s", async (mode) => {
    const h = await boot();
    const approval = await h.approved();
    if (mode === "switch") await h.store.setOperatorLineEnabled(false, "staff");
    if (mode === "env") h.env.OPERATOR_LINE_INBOUND_ENABLED = "false";
    if (mode === "storage") vi.spyOn(h.store, "getOperatorLineEnabled").mockRejectedValue(new Error("unavailable"));
    expect((await h.request("/prepare_operator_call", INPUT)).status).toBe(503);
    expect((await h.request("/commit_call_live", { confirmToken: approval.confirmToken })).status).toBe(503);
    expect((await h.store.getApproval(approval.id))!.confirmUsedAt).toBeNull();
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("rechecks the kill-switch after storage preparation immediately before dialing", async () => {
    const h = await boot(); const approval = await h.approved();
    const persist = h.store.saveOperatorCall.bind(h.store);
    vi.spyOn(h.store, "saveOperatorCall").mockImplementation(async (record) => {
      await persist(record);
      await h.store.setOperatorLineEnabled(false, "staff");
    });
    expect((await h.request("/commit_call_live", { confirmToken: approval.confirmToken })).body).toMatchObject({ error: "Call was not placed: operator_line_disabled", outcome: "not_sent" });
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("has NO daily cap and NO peak window, even for repeated calls to the same number", async () => {
    const h = await boot();
    h.clock.at = new Date("2026-11-01T08:00:00Z"); // Early Sunday morning Pacific.
    h.env.OUTBOUND_DAILY_CAP = "0";
    h.env.OUTBOUND_CAMPAIGN_WAYNE_OPERATOR = "0";
    const prior = vi.spyOn(h.outbound, "priorAttempts").mockRejectedValue(new Error("campaign caps must not run"));
    const count = vi.spyOn(h.outbound, "callsInFlight").mockRejectedValue(new Error("campaign caps must not run"));
    for (let i = 0; i < 12; i++) {
      const approved = await h.approved();
      expect((await h.request("/commit_call_live", { confirmToken: approved.confirmToken })).status).toBe(200);
    }
    expect(h.sender.createCall).toHaveBeenCalledTimes(12);
    expect(prior).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("excludes the operator from scheduled campaigns even if its campaign flag is enabled", async () => {
    const getAgentConfig = vi.fn(() => { throw new Error("operator campaign policy must not be evaluated"); });
    expect(await enabledCampaigns({ env: { OUTBOUND_CAMPAIGN_WAYNE_OPERATOR: "1" }, slugs: async () => [OPERATOR_SLUG],
      laneSource: async () => ({ getAgentConfig }) })).toEqual([]);
    expect(getAgentConfig).not.toHaveBeenCalled();
  });

  it.each(["machine_end_beep", "busy", "failed"])("does not evaluate campaign caps/windows for operator completion %s", async (status) => {
    const h = await boot(); const approved = await h.approved();
    const live = await h.request("/commit_call_live", { confirmToken: approved.confirmToken });
    expect(live.status).toBe(200);
    const options = h.sender.createCall.mock.calls[0][0];
    const policy = { ...operatorLinePolicy, get caps(): never { throw new Error("NO operator caps"); }, get window(): never { throw new Error("NO operator peak window"); } };
    const env = { ...h.env, TWILIO_AUTH_TOKEN: "synthetic-auth", DATABASE_URL: "postgres://test", XAI_API_KEY: "synthetic-unused" };
    const url = status.startsWith("machine") ? options.url : options.statusCallback;
    const body = { CallSid: live.body.callSid, From: options.from, To: PHONE, AnsweredBy: status.startsWith("machine") ? status : "human", CallStatus: status };
    const req = { originalUrl: new URL(url).pathname + new URL(url).search, body, headers: { host: "fleet.example", "x-forwarded-proto": "https",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, url, body) } };
    const deps = { env, registry: new CallSessionRegistry(), store: h.outbound, operatorStore: () => h.store, liveCalls: h.sessions, policyFor: () => policy };
    const prior = vi.spyOn(h.outbound, "priorAttempts").mockRejectedValue(new Error("NO operator caps"));
    const response = status.startsWith("machine") ? await handleOutboundAnswer(OPERATOR_SLUG, req, deps) : await handleOutboundStatus(OPERATOR_SLUG, req, deps);
    expect(response.status).toBe(status.startsWith("machine") ? 200 : 204);
    expect(prior).not.toHaveBeenCalled();
  });

  it("expands an optional scenario into the locked outbound free-form goal", async () => {
    const h = await boot();
    const approved = await h.approved({ phone: PHONE, scenario_id: "A9" });
    const response = await h.request("/commit_call_live", { confirmToken: approved.confirmToken });
    expect(response.status).toBe(200);
    expect(h.sessions.get(response.body.sessionId)!.operatorCall).toMatchObject({ scenario_id: "A9", purpose: expect.stringContaining("Tomas Benchmark") });
    expect((await h.store.getApproval(approved.id))!.payload).toMatchObject({ scenario_id: "A9" });
  });

  it.each(["sms", "voicemail"] as const)("fetches private %s content only with the operator bot scope and keeps audits redacted", async (kind) => {
    const h = await boot();
    const id = kind === "sms" ? `SM${"a".repeat(32)}` : `RE${"b".repeat(32)}`;
    const fetchUrl = `https://fleet.example/api/plugin/v1/operator-line/${kind}/${id}`;
    if (kind === "sms") await h.store.saveOperatorSms({ messageSid: id, callerNumber: PHONE, body: "PRIVATE SMS BODY", receivedAt: h.clock.at, fetchUrl });
    else await h.store.saveOperatorVoicemail({ recordingSid: id, callSid: `CA${"c".repeat(32)}`, recordingUrl: "https://api.twilio.com/PRIVATE-recording",
      transcript: "PRIVATE VOICEMAIL", transcriptionStatus: "completed", receivedAt: h.clock.at, fetchUrl });
    await h.store.setOperatorLineEnabled(false, "staff"); // Existing content remains fetchable.
    const path = `/operator-line/${kind}/${id}`;
    for (const bot of [h.bot, h.store.mint(["operator:call"])]) {
      const response = await h.request(path, undefined, bot);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(kind === "sms" ? response.body.body : response.body.transcript).toContain("PRIVATE");
    }
    for (const token of [h.staff, h.other, h.store.mint(), h.store.mint(["operator:call", "contacts:approve"])]) {
      expect((await h.request(path, undefined, token)).status).toBe(403);
    }
    expect((await h.request(`/operator-line/${kind}/unrelated`)).status).toBe(404);
    const audit = JSON.stringify(await h.store.listAudit());
    expect(audit).not.toContain(id);
    expect(audit).not.toMatch(/PRIVATE|15555550123|19094795435/);
    const get = kind === "sms" ? "getOperatorSms" : "getOperatorVoicemail";
    vi.spyOn(h.store, get).mockRejectedValue(new Error("private error"));
    expect((await h.request(path)).status).toBe(503);
  });

  it.each(["owner_request", "bot_initiative", undefined] as const)("applies the outbound approval policy and persists %s", async (initiatedBy) => {
    const h = await boot();
    const prepared = await h.request("/prepare_operator_call", { ...INPUT, ...(initiatedBy ? { initiated_by: initiatedBy } : {}) });
    const automatic = initiatedBy === "owner_request";
    expect(prepared.status).toBe(201);
    expect(prepared.body.status).toBe(automatic ? "approved" : "pending_approval");
    const row = (await h.store.getApproval(prepared.body.approval.id))!;
    expect(row.payload.initiated_by).toBe(initiatedBy ?? "bot_initiative");
    expect(row.approvedBy).toBeNull();
    let confirmToken = prepared.body.confirmToken;
    if (!automatic) {
      expect(confirmToken).toBeUndefined();
      expect((await h.request(`/contact_requests/${row.id}/confirm_token`)).status).toBe(409);
      expect(h.sender.createCall).not.toHaveBeenCalled();
      const approved = await h.request(`/approvals/${row.id}/approve`, { payloadHash: row.payloadHash }, h.staff);
      confirmToken = approved.body.confirmToken;
    }
    const live = await h.request("/commit_call_live", { confirmToken });
    expect(live.status).toBe(200);
    const session = h.sessions.get(live.body.sessionId)!;
    await h.sessions.persist(session);
    expect(await h.store.getOperatorCall(session.sessionId)).toMatchObject({ initiatedBy: initiatedBy ?? "bot_initiative" });
    const replay = await h.request("/commit_call_live", { confirmToken });
    expect(replay.status).toBe(409);
    expect(h.sender.createCall).toHaveBeenCalledOnce();
    expect(JSON.stringify(await h.store.listAudit())).not.toContain(confirmToken);
  });

  it("allows a bot-initiative call to the configured owner without an approval tap", async () => {
    const h = await boot();
    h.env.OPERATOR_OWNER_NUMBER = PHONE;
    const prepared = await h.request("/prepare_operator_call", INPUT);
    expect(prepared.body.status).toBe("approved");
    expect((await h.request("/commit_call_live", { confirmToken: prepared.body.confirmToken })).status).toBe(200);
    expect((await h.store.getApproval(prepared.body.approval.id))!.payload.initiated_by).toBe("bot_initiative");
    for (const owner of [undefined, "invalid", "+15555550999"]) {
      h.env.OPERATOR_OWNER_NUMBER = owner;
      expect((await h.request("/prepare_operator_call", INPUT)).body.status).toBe("pending_approval");
    }
  });

  it("accepts requested_by as an alias and rejects invalid or conflicting provenance", async () => {
    const h = await boot();
    const prepared = await h.request("/prepare_operator_call", { ...INPUT, requested_by: "owner_request" });
    expect(prepared.body.status).toBe("approved");
    const row = (await h.store.getApproval(prepared.body.approval.id))!;
    expect(row.payload).toMatchObject({ initiated_by: "owner_request" });
    expect(row.payload).not.toHaveProperty("requested_by");
    for (const provenance of [{ initiated_by: "staff" }, { requested_by: "owner" }, { initiated_by: null }, { requested_by: ["owner_request"] }, { initiated_by: "owner_request", requested_by: "bot_initiative" }]) {
      expect((await h.request("/prepare_operator_call", { ...INPUT, ...provenance })).status).toBe(400);
    }
  });

  it.each([undefined, "0", "-1", "oops", "Infinity", "999999999999"])("uses a 60-minute safety maximum for missing/invalid settings (%s)", (minutes) => {
    expect(operatorMaxDurationSec({ OPERATOR_LINE_MAX_CALL_MINUTES: minutes })).toBe(3600);
  });

  it("uses the configured safety maximum for outbound goals without a script", async () => {
    const h = await boot();
    h.env.OPERATOR_LINE_MAX_CALL_MINUTES = "90";
    const prepared = await h.request("/prepare_operator_call", { ...INPUT, initiated_by: "owner_request" });
    expect((await h.store.getApproval(prepared.body.approval.id))!.payload.maxDurationSec).toBe(5400);
    expect((await h.request("/commit_call_live", { confirmToken: prepared.body.confirmToken })).status).toBe(200);
    expect(h.sender.createCall).toHaveBeenCalledWith(expect.objectContaining({ timeLimit: 5400 }));
    expect(parseOperatorPayload({ ...INPUT, maxDurationSec: 5401 }, h.env).ok).toBe(false);
  });
  it("exposes inbound transcripts only to operator bots, scoped to the inbound table, with private caching and redacted audit", async () => {
    const h = await boot();
    const callSid = `CA${"a".repeat(32)}`;
    await h.store.startOperatorInboundCall({ callId: "inbound-record", callSid, laneSlug: OPERATOR_SLUG, direction: "inbound",
      callerNumber: PHONE, status: "in_progress", startedAt: h.clock.at, endedAt: null,
      turns: [], queuedRequests: [], optedOut: false,
      transcriptUrl: `https://fleet.example/api/plugin/v1/operator-line/inbound/${callSid}` });
    await h.store.appendOperatorInboundRequest(callSid, { id: "request-id", text: "Please arrange a meeting", createdAt: h.clock.at.toISOString() });
    await h.store.finishOperatorInboundCall(callSid, h.clock.at, "completed", [{ role: "caller", text: "Confirmed meeting request", atMs: h.clock.at.getTime() }]);
    const path = `/operator-line/inbound/${callSid}`;
    const response = await h.request(path);
    expect(response).toMatchObject({ status: 200, body: { callSid, callerNumber: PHONE, direction: "inbound", queuedRequests: [expect.objectContaining({ id: "request-id", text: "Please arrange a meeting" })],
      transcript: [{ role: "caller", text: "Confirmed meeting request", at: h.clock.at.toISOString() }] } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Inbound has no initiating token owner: any explicitly scoped bot can fetch.
    expect((await h.request(path, undefined, h.store.mint(["operator:call"]))).status).toBe(200);
    for (const token of [h.staff, h.other, h.store.mint(), h.store.mint(["operator:call", "contacts:approve"])]) {
      expect((await h.request(path, undefined, token)).status).toBe(403);
    }
    expect((await h.request(path, undefined, { plaintext: "invalid" } as typeof h.bot)).status).toBe(401);
    expect((await h.request("/operator-line/inbound/CA-unrelated")).status).toBe(404);
    const approved = await h.approved();
    const outbound = await h.request("/commit_call_live", { confirmToken: approved.confirmToken });
    expect((await h.request(`/operator-line/inbound/${outbound.body.callSid}`)).status).toBe(404);
    const audit = await h.store.listAudit();
    expect(audit).toContainEqual(expect.objectContaining({ tool: "operator_inbound_transcript", outcome: "ok", httpStatus: 200 }));
    expect(JSON.stringify(audit)).not.toContain(PHONE);
    expect(JSON.stringify(audit)).not.toMatch(/Confirmed meeting request|Please arrange a meeting/);
  });

  it("fails closed if inbound transcript storage is unavailable", async () => {
    const h = await boot();
    vi.spyOn(h.store, "getOperatorInboundCall").mockRejectedValue(new Error("private provider error"));
    expect(await h.request(`/operator-line/inbound/CA${"a".repeat(32)}`)).toMatchObject({ status: 503, body: { error: "Operator inbound storage is unavailable" } });
  });

  it("uses parameterized inbound SQL with atomic completion and explicit lane/direction constraints", async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const store = createSqlPluginStore(exec);
    await store.getOperatorInboundCall("CA-unrelated");
    expect(exec).toHaveBeenLastCalledWith(expect.stringContaining("lane_slug = 'wayne-operator' AND direction = 'inbound'"), ["CA-unrelated"]);
    await store.appendOperatorInboundRequest("CA-inbound", { id: "request-id", text: "Arrange a meeting", createdAt: hDate().toISOString() });
    expect(exec).toHaveBeenLastCalledWith(expect.stringContaining("ended_at IS NULL"), ["CA-inbound",
      JSON.stringify([{ id: "request-id", text: "Arrange a meeting", createdAt: hDate().toISOString() }]), JSON.stringify([{ id: "request-id" }])]);
    expect(exec.mock.calls[exec.mock.calls.length - 1][0]).not.toContain("Arrange a meeting");
    await store.finishOperatorInboundCall("CA-inbound", hDate(), "completed", []);
    expect(exec).toHaveBeenLastCalledWith(expect.stringMatching(/ended_at IS NULL.*RETURNING/), ["CA-inbound", hDate().toISOString(), "completed", "[]"]);
    function hDate() { return new Date(OPEN); }
  });

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
    expect(row).toMatchObject({ channel: "call", ticketId: null, ticketNumber: null, payload: { callKind: "operator", maxDurationSec: 3600 } });
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
      to: PHONE, from: h.env.OPERATOR_LINE_FROM_NUMBER, timeLimit: 3600,
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
    for (const secret of [PHONE, INPUT.purpose, a.confirmToken, h.bot.plaintext]) expect(audit).not.toContain(secret);
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
    expect((await h.request("/prepare_operator_call", { ...INPUT, phone })).status).toBe(409);
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
    { phone: "9094795435" }, { maxDurationSec: 29 }, { maxDurationSec: 3601 }, { maxDurationSec: 30.5 },
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
    const deps = { env, registry, store: h.outbound, operatorStore: () => h.store, liveCalls: h.sessions, policyFor: () => operatorLinePolicy };
    const body = { CallSid: "CA-operator-early", From: h.env.OPERATOR_LINE_FROM_NUMBER!, To: PHONE, AnsweredBy: "human" };
    function signed(url: string, fields: Record<string, string>) {
      return { originalUrl: new URL(url).pathname + new URL(url).search, body: fields, headers: { host: "fleet.example", "x-forwarded-proto": "https",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, url, fields) } };
    }
    h.sender.createCall.mockImplementation(async (options) => {
      const invalid = signed(options.url, body); invalid.headers["x-twilio-signature"] = "invalid";
      expect((await handleOutboundAnswer(OPERATOR_SLUG, invalid, deps)).status).toBe(403);
      expect((await handleOutboundAnswer("si-assistant", signed(options.url, body), deps)).body).toContain("<Hangup/>");
      await h.store.setOperatorLineEnabled(false, "staff");
      expect((await handleOutboundAnswer(OPERATOR_SLUG, signed(options.url, body), deps)).body).not.toContain("<Stream");
      await h.store.setOperatorLineEnabled(true, "staff");
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

  it.each(["owner_request", "bot_initiative"] as const)("round-trips ordered transcripts and %s with parameterized SQL", async (initiatedBy) => {
    const record = { initiatedBy, sessionId: "session", approvalId: "approval", tokenJti: "bot", callSid: "CA-test", status: "completed", startedAt: new Date(1000), endedAt: new Date(3000), turns: [{ role: "caller" as const, text: "synthetic words", atMs: 2000 }] };
    const exec = vi.fn().mockResolvedValue([]);
    const store = createSqlPluginStore(exec);
    await store.saveOperatorCall(record);
    expect(exec.mock.calls[0][0]).toContain("ON CONFLICT (session_id)");
    expect(exec.mock.calls[0][0]).not.toContain(record.turns[0].text);
    expect(exec.mock.calls[0][0]).toContain("initiated_by");
    expect(exec.mock.calls[0][1][8]).toBe(initiatedBy);
    exec.mockResolvedValue([{ session_id: record.sessionId, approval_id: record.approvalId, token_jti: record.tokenJti, call_sid: record.callSid,
      status: record.status, started_at: record.startedAt.toISOString(), ended_at: record.endedAt.toISOString(), turns: JSON.stringify(record.turns), initiated_by: record.initiatedBy }]);
    expect(await store.getOperatorCall("session")).toEqual(record);
  });
});

describe("open two-way operator line (Wayne, Oct 29)", () => {
  it.each(["bot_initiative", undefined] as const)("needs no human approval for a free-text %s call to any number", async (initiated_by) => {
    const h = await boot();
    h.env.OPERATOR_OWNER_NUMBER = "+15555550999"; // Not the destination.
    const prepared = await h.request("/prepare_operator_call", { ...INPUT, ...(initiated_by ? { initiated_by } : {}) });
    expect(prepared).toMatchObject({ status: 201, body: { status: "approved", approval: { status: "approved" } } });
    expect(typeof prepared.body.confirmToken).toBe("string");
    const live = await h.request("/commit_call_live", { confirmToken: prepared.body.confirmToken });
    expect(live).toMatchObject({ status: 200, body: { status: "live" } });
    expect(h.sender.createCall).toHaveBeenCalledOnce();
  });

  it("keeps task-specific lines (SI support desk) behind a human approval", async () => {
    const h = await boot();
    const patientBot = h.store.mint(["contacts:prepare", "contacts:commit"]);
    const patient = await h.request("/prepare_call", { phone: PHONE, dateOfBirth: "1950-03-17", purpose: "Synthetic test" }, patientBot);
    expect(patient).toMatchObject({ status: 201, body: { status: "pending_approval", approval: { status: "pending" } } });
    expect(patient.body.confirmToken).toBeUndefined();
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });
});
