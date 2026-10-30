import { afterEach, describe, expect, it, vi } from "vitest";
import type { Express, RequestHandler } from "express";
import { MemoryPluginStore, type ContactChannel } from "./store";
import { approveContact, cancelContact, consumeConfirmToken, prepareContact, reapStaleSending } from "./approvals";
import { mountPluginApi } from "./routes";
import { LiveCallRegistry, LIVE_RETENTION_MS } from "./liveSessions";
import type { LiveCallSender } from "./liveCalls";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";
import { runCampaignTick } from "../runtime/outbound/dialer";
import { siAssistantPolicy } from "../agents/siAssistantAgent";
import { createSqlPluginStore } from "./sqlStore";
import { handleInboundSms, sendApprovedSms } from "./sms";
import { PRACTICE_CLOSURES } from "../runtime/outbound/callingWindow";
import { CONFIRM_TTL_MS } from "./tokens";
import { DEFAULT_PLUGIN_SCOPES, isWritePluginScope, mintScopesCompatible, parseScopes } from "./scopes";
import twilio from "twilio";
import { CallSessionRegistry } from "../runtime/sessionRegistry";
import { handleOutboundAnswer, handleOutboundStatus } from "../runtime/outbound/outboundWebhook";

const PHONE = "+15555550111";
const OPEN = "2026-10-22T18:00:00Z";
const registries: LiveCallRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) registry.clear();
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
    SI_ASSISTANT_NUMBER: "+19092553213", DOMAIN: "fleet.example", APP_ENV: "production",
  };
  const sender = {
    createCall: vi.fn<LiveCallSender["createCall"]>().mockResolvedValue({ sid: "CA-live" }),
    voiceUrlFor: vi.fn<LiveCallSender["voiceUrlFor"]>().mockResolvedValue("https://fleet.example/voice/si-assistant"),
    endCall: vi.fn<LiveCallSender["endCall"]>().mockResolvedValue({}),
  };
  const sms = { send: vi.fn().mockResolvedValue({ sid: "SM-test" }) };
  const bot = store.mint(["fleet:read", "contacts:prepare", "contacts:commit"]);
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
  async function approved(channel: ContactChannel = "call") {
    const payload = channel === "call" ? { phone: PHONE, firstName: "Testa", lastName: "Example", dateOfBirth: "1950-03-17", purpose: "private context" }
      : channel === "sms" ? { phone: PHONE, body: "private message" } : { to: "test@example.com", subject: "Private", body: "private message" };
    const prep = await prepareContact(store, bot.jti, { channel, payload } as any, clock.at);
    if (!prep.ok) throw new Error(prep.error);
    const approval = await approveContact(store, prep.approval.id, staff.jti, clock.at, prep.approval.payloadHash);
    if (!approval.ok) throw new Error(approval.error);
    return { id: approval.approval.id, confirmToken: approval.confirmToken! };
  }
  return { clock, store, outbound, sessions, env, sender, sms, bot, staff, other, request, approved };
}

describe("direct open-line calls", () => {
  const input = { phone: PHONE, purpose: "Ask about office hours", name: "Private Recipient" };

  it("requires an explicit write scope, excludes staff, and keeps mint defaults", async () => {
    const h = await boot();
    expect(DEFAULT_PLUGIN_SCOPES).toEqual(["fleet:read"]);
    expect(parseScopes([])).toEqual(["fleet:read"]);
    expect(isWritePluginScope("calls:direct")).toBe(true);
    expect(mintScopesCompatible(["calls:direct", "contacts:approve"]).ok).toBe(false);
    expect(mintScopesCompatible(["calls:direct"]).ok).toBe(true);
    for (const token of [h.bot, h.staff, h.other, h.store.mint(), h.store.mint(["calls:direct", "contacts:approve"])]) {
      expect((await h.request("/calls/direct", input, token)).status).toBe(403);
    }
    expect(h.sender.createCall).not.toHaveBeenCalled();
    expect(await h.store.listAudit()).toHaveLength(5);
  });

  it.each(["voice", "sms_stop"])("refuses %s at the opt-out guard and audits the reason", async (source) => {
    const h = await boot(); const bot = h.store.mint(["calls:direct"]);
    if (source === "voice") await h.outbound.stampDoNotContact(PHONE, "voice");
    else await h.store.setSmsOptOut(PHONE.slice(-10), true);
    const result = await h.request("/calls/direct", input, bot);
    expect(result).toMatchObject({ status: 409, body: { reason: "do_not_contact", outcome: "not_sent" } });
    expect(h.sender.createCall).not.toHaveBeenCalled();
    expect(h.outbound.attempts).toHaveLength(0);
    expect(await h.store.listAudit()).toContainEqual(expect.objectContaining({ tokenJti: bot.jti, outcome: "denied",
      createdAt: h.clock.at, details: { maskedNumber: "***0111", purpose: input.purpose.toLowerCase(), reason: "do_not_contact" } }));
  });

  it("places immediately from 909-255-3213, registers a live session, and exposes the existing controls", async () => {
    const h = await boot(); const bot = h.store.mint(["calls:direct"]);
    // Direct calls bypass windows/holidays, per-phone history and callback routing.
    h.clock.at = new Date("2026-11-11T07:00:00Z");
    h.outbound.addContact({ id: "prior-direct", phone: PHONE, status: "completed" });
    for (let i = 0; i < 12; i++) h.outbound.attempts.push({ id: `old${i}`, contactId: "prior-direct", campaignId: h.outbound.campaignId,
      attemptNumber: i + 1, at: h.clock.at, endedAt: h.clock.at });
    h.sender.voiceUrlFor.mockResolvedValue("https://unrelated.example/");
    delete h.env.SI_ASSISTANT_NUMBER; // Shared SI Assistant default, +19092553213.
    const result = await h.request("/calls/direct", { ...input, phone: "5555550111" }, bot);
    expect(result).toMatchObject({ status: 200, body: { status: "live", callSid: "CA-live", sessionId: expect.any(String) } });
    const session = h.sessions.owned(result.body.sessionId, bot.jti)!;
    expect(session).toMatchObject({ approvalId: null, callSid: "CA-live", directCall: { purpose: input.purpose, name: input.name } });
    expect(h.store.approvals.size).toBe(0);
    expect(h.sender.voiceUrlFor).not.toHaveBeenCalled();
    expect(h.sender.createCall).toHaveBeenCalledWith(expect.objectContaining({ to: PHONE, from: "+19092553213",
      url: expect.stringContaining(`liveSession=${session.sessionId}`), statusCallback: expect.stringContaining(`liveSession=${session.sessionId}`) }));
    expect(h.sender.createCall.mock.calls[0][0]).not.toHaveProperty("machineDetection");
    const directContact = h.outbound.contacts.get(session.contactId)!;
    expect(directContact.customData).toMatchObject({ plugin_live: true, plugin_direct: true });
    expect(JSON.stringify(directContact)).not.toContain(input.purpose);
    expect((await h.request(`/live_calls/${session.sessionId}`, undefined, bot)).status).toBe(200);
    const instruct = vi.fn(); const end = vi.fn();
    h.sessions.attach("CA-live", { turns: () => [], instruct, end });
    expect((await h.request(`/live_calls/${session.sessionId}/instruct`, { text: "Ask about availability" }, bot)).status).toBe(200);
    expect(instruct).toHaveBeenCalledWith("Ask about availability");
    const stranger = h.store.mint(["calls:direct"]);
    expect((await h.request(`/live_calls/${session.sessionId}/end`, {}, stranger)).status).toBe(403);
    expect((await h.request(`/live_calls/${session.sessionId}/end`, {}, bot)).status).toBe(200);
    expect(h.sender.endCall).toHaveBeenCalledWith("CA-live");
    expect(end).toHaveBeenCalledOnce();
  });

  it("uses signed live webhooks to bind an early answer, carry the session into the voice registry, and settle the attempt", async () => {
    const h = await boot(); const bot = h.store.mint(["calls:direct"]);
    const registry = new CallSessionRegistry();
    const env = { ...h.env, TWILIO_AUTH_TOKEN: "test-auth", DATABASE_URL: "postgres://test", XAI_API_KEY: "test-unused" };
    const deps = { env, registry, store: h.outbound, liveCalls: h.sessions, policyFor: () => siAssistantPolicy };
    const body = { CallSid: "CA-early-direct", From: "+19092553213", To: PHONE, AnsweredBy: "human" };
    function signed(url: string, fields: Record<string, string>) {
      return { originalUrl: new URL(url).pathname + new URL(url).search, body: fields,
        headers: { host: "fleet.example", "x-forwarded-proto": "https",
          "x-twilio-signature": twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, url, fields) } };
    }
    h.sender.createCall.mockImplementation(async (options) => {
      const response = await handleOutboundAnswer("si-assistant", signed(options.url, body), deps);
      expect(response.body).toContain("<Connect><Stream");
      return { sid: body.CallSid };
    });
    const result = await h.request("/calls/direct", input, bot);
    expect(result.status).toBe(200);
    expect(registry.get(body.CallSid)).toMatchObject({ liveSessionId: result.body.sessionId, outbound: { campaignKey: "si-assistant" } });
    const session = h.sessions.owned(result.body.sessionId, bot.jti)!;
    expect(session).toMatchObject({ callSid: body.CallSid, status: "in_progress", directCall: { purpose: input.purpose } });
    const callback = h.sender.createCall.mock.calls[0][0].statusCallback;
    await handleOutboundStatus("si-assistant", signed(callback, { ...body, CallStatus: "completed" }), deps);
    expect(session.status).toBe("completed");
    expect(h.outbound.attempts[0].endedAt).toBeDefined();
    expect(h.outbound.contacts.get(session.contactId)?.status).toBe("answered");
  });

  it("keeps approval sessions behind their existing commit scope", async () => {
    const h = await boot(); const a = await h.approved();
    const result = await h.request("/commit_call_live", { confirmToken: a.confirmToken });
    // Even the owner needs contacts:commit for an approval-based session.
    h.store.tokens.get(h.bot.jti)!.scopes = ["calls:direct"];
    expect((await h.request(`/live_calls/${result.body.sessionId}`)).status).toBe(403);
  });

  it.each([
    { phone: "+442012345678", purpose: "Call" }, { phone: PHONE }, { phone: PHONE, purpose: " " },
    { phone: PHONE, purpose: "x".repeat(4001) }, { ...input, name: "x".repeat(101) },
  ])("rejects invalid input and audits every refusal", async (body) => {
    const h = await boot(); const bot = h.store.mint(["calls:direct"]);
    expect((await h.request("/calls/direct", body, bot)).status).toBe(400);
    expect(await h.store.listAudit()).toHaveLength(1);
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("masks phone numbers and redacts PHI before truncating the audit purpose", async () => {
    const h = await boot(); const bot = h.store.mint(["calls:direct"]);
    const purpose = `Call Private Recipient at ${PHONE}; DOB 1950-03-17; secret@example.com cataract. ${"Ask about office hours. ".repeat(30)}`;
    expect((await h.request("/calls/direct", { ...input, purpose }, bot)).status).toBe(200);
    const entries = await h.store.listAudit();
    expect(entries[0]).toMatchObject({ tokenJti: bot.jti, createdAt: h.clock.at, tool: "direct_call", outcome: "committed",
      details: { maskedNumber: "***0111", reason: "placed" } });
    expect(entries[0].details!.purpose!.length).toBeLessThanOrEqual(160);
    for (const secret of [PHONE, "555555", "Private", "Recipient", "1950", "secret@example.com", "cataract"]) {
      expect(JSON.stringify(entries)).not.toContain(secret);
    }
    const exec = vi.fn().mockResolvedValue([]);
    await createSqlPluginStore(exec).writeAudit(entries[0]);
    expect(exec.mock.calls[0][0]).toContain("details, created_at");
    expect(JSON.stringify(exec.mock.calls)).not.toContain(PHONE);
  });

  it("honors the write switch and audits that refusal", async () => {
    const h = await boot(); const bot = h.store.mint(["calls:direct"]);
    h.env.PLUGIN_WRITES_ENABLED = "false";
    expect((await h.request("/calls/direct", input, bot)).status).toBe(403);
    expect(h.sender.createCall).not.toHaveBeenCalled();
    expect(await h.store.listAudit()).toHaveLength(1);
  });

  it("audits rejected authentication without logging token secrets", async () => {
    const h = await boot();
    const result = await h.request("/calls/direct", input, { plaintext: "invalid-token" } as any);
    expect(result.status).toBe(401);
    expect(await h.store.listAudit()).toContainEqual(expect.objectContaining({ tokenJti: "unauthenticated", outcome: "denied", httpStatus: 401 }));
    expect(JSON.stringify(await h.store.listAudit())).not.toContain("invalid-token");
  });

  it.each(["Call Will about office hours", "Ask Price about pickup"])("retains a sanitized fallback for %j when audit persistence is unavailable", async (purpose) => {
    const h = await boot(); const bot = h.store.mint(["calls:direct"]);
    vi.spyOn(h.store, "writeAudit").mockRejectedValue(new Error("database unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await h.request("/calls/direct", { ...input, purpose }, bot)).status).toBe(200);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("database unavailable"), expect.objectContaining({
      tokenJti: bot.jti, at: h.clock.at.toISOString(), details: expect.objectContaining({ maskedNumber: "***0111", reason: "placed" }),
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(PHONE);
    expect(JSON.stringify(log.mock.calls)).not.toContain(input.name);
    expect(JSON.stringify(log.mock.calls).toLowerCase()).not.toMatch(/\b(?:will|price)\b/);
  });

  it("sends the successful response before starting an audit write that never resolves", async () => {
    vi.useFakeTimers();
    const h = await boot(); const bot = h.store.mint(["calls:direct"]);
    const order: string[] = [];
    vi.spyOn(h.store, "writeAudit").mockImplementation(() => {
      order.push("audit");
      return new Promise<void>(() => {});
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await h.request("/calls/direct", input, bot, () => order.push("response"));
    expect(result).toMatchObject({ status: 200, body: { status: "live", sessionId: expect.any(String) } });
    expect(h.sessions.owned(result.body.sessionId, bot.jti)).not.toBeNull();
    expect(order).toEqual(["response", "audit"]);
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(PHONE);
    expect(JSON.stringify(log.mock.calls)).not.toContain(input.name);
  });

  it.each([true, false])("bounds stalled audit writes on refusals (authentication: %s)", async (authentication) => {
    vi.useFakeTimers();
    const h = await boot();
    const bot = authentication ? { ...h.bot, plaintext: "invalid-token" } : h.store.mint(["calls:direct"]);
    const write = vi.spyOn(h.store, "writeAudit").mockImplementation(() => new Promise<void>(() => {}));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = h.request("/calls/direct", { ...input, phone: "invalid" }, bot);
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    expect(await response).toMatchObject({ status: authentication ? 401 : 400 });
    expect(h.sender.createCall).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("database unavailable"), expect.objectContaining({ outcome: "denied" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("audits a provider failure without retrying (clear refusal: %s)", async (clear) => {
    const h = await boot(); const bot = h.store.mint(["calls:direct"]);
    h.sender.createCall.mockRejectedValue(clear ? Object.assign(new Error("private provider detail"), { name: "RestException", status: 400 }) : new Error("private provider detail"));
    const result = await h.request("/calls/direct", input, bot);
    expect(result.body.outcome).toBe(clear ? "not_sent" : "unknown");
    if (!clear) expect(h.sessions.owned(result.body.sessionId, bot.jti)).not.toBeNull();
    expect(h.sender.createCall).toHaveBeenCalledOnce();
    const entries = await h.store.listAudit();
    expect(entries[0].outcome).toBe(clear ? "denied" : "unknown");
    expect(JSON.stringify(entries)).not.toContain("private provider detail");
    expect(await h.outbound.dialableContacts(h.outbound.campaignId, new Date(h.clock.at.getTime() + 86_400_000), 10)).toEqual([]);
  });
});

describe("confirm token hand-off", () => {
  it("returns the preparing bot's token once, without leaking it through views or audit", async () => {
    const h = await boot();
    const a = await h.approved();
    const path = `/contact_requests/${a.id}/confirm_token`;
    expect((await h.request(path, undefined, h.other)).status).toBe(404);
    expect((await h.request(path, undefined, h.staff)).status).toBe(403);
    const results = await Promise.all([h.request(path), h.request(path)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 200)?.body).toEqual({ confirmToken: a.confirmToken,
      expiresAt: new Date(h.clock.at.getTime() + CONFIRM_TTL_MS).toISOString() });
    expect(results[0].headers.get("cache-control")).toBe("no-store");
    expect((await h.store.getApproval(a.id))?.confirmTokenPlaintext).toBeNull();
    const view = await h.request(`/get_contact_request?id=${a.id}`);
    expect(JSON.stringify(view.body)).not.toContain(a.confirmToken);
    expect(JSON.stringify(await h.store.listAudit())).not.toContain(a.confirmToken);
    // Hand-off is not consumption; the token still commits exactly once.
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken })).status).toBe(200);
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken })).status).toBe(409);
  });

  it.each(["consume", "cancel", "expiry"])("clears the secret on %s and refuses hand-off", async (action) => {
    const h = await boot(); const a = await h.approved();
    if (action === "consume") await consumeConfirmToken(h.store, a.confirmToken, h.clock.at);
    if (action === "cancel") await cancelContact(h.store, a.id, h.clock.at);
    if (action === "expiry") { h.clock.at = new Date(h.clock.at.getTime() + CONFIRM_TTL_MS); await reapStaleSending(h.store, h.clock.at); }
    expect((await h.store.getApproval(a.id))?.confirmTokenPlaintext).toBeNull();
    expect((await h.request(`/contact_requests/${a.id}/confirm_token`)).status).toBe(409);
  });

  it("refuses hand-off before approval", async () => {
    const h = await boot();
    const prep = await prepareContact(h.store, h.bot.jti, { channel: "sms", payload: { phone: PHONE, body: "hi" } }, h.clock.at);
    if (!prep.ok) throw new Error();
    expect((await h.request(`/contact_requests/${prep.approval.id}/confirm_token`)).status).toBe(409);
  });

  it("SQL fetch uses an atomic owner/status/expiry check and read-and-clear", async () => {
    const exec = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ confirm_token_plaintext: "secret", confirm_expires_at: OPEN }]);
    const sql = createSqlPluginStore(exec);
    expect(await sql.takeConfirmToken("id", "owner", new Date(OPEN))).toEqual({ confirmToken: "secret", expiresAt: new Date(OPEN) });
    expect(exec.mock.calls[1][0]).toMatch(/UPDATE contact_approvals SET confirm_token_plaintext = NULL/);
    expect(exec.mock.calls[1][0]).toMatch(/token_jti = \$2 AND status = 'approved'/);
    expect(exec.mock.calls[1][0]).toMatch(/confirm_used_at IS NULL AND confirm_expires_at > \$3/);
    expect(exec.mock.calls[1][1]).toEqual(["id", "owner", OPEN.replace("Z", ".000Z")]);
    const consumeExec = vi.fn().mockResolvedValue([]);
    await createSqlPluginStore(consumeExec).claimConfirmToken("hash", new Date(OPEN));
    expect(consumeExec.mock.calls[0][0]).toContain("confirm_token_plaintext = NULL");
  });
});

describe("live calls", () => {
  it("advertises capabilities with fleet:read", async () => {
    const h = await boot();
    expect(await h.request("/capabilities")).toMatchObject({ status: 200, body: { liveCalls: true, confirmTokenHandoff: true, smsHoursEnforced: true } });
    expect((await h.request("/capabilities", undefined, h.staff)).status).toBe(403);
  });

  it("dials the SI Assistant immediately and records an ordinary campaign attempt", async () => {
    const h = await boot(); const a = await h.approved();
    const result = await h.request("/commit_call_live", { confirmToken: a.confirmToken });
    expect(result).toMatchObject({ status: 200, body: { status: "live", callSid: "CA-live", approval: { status: "committed" } } });
    const attempt = h.outbound.attempts[0];
    const contact = h.outbound.contacts.get(attempt.contactId)!;
    expect(contact).toMatchObject({ status: "calling", attempts: 1, contacted: true, customData: { plugin_live: true, date_of_birth: "1950-03-17", approval_id: a.id } });
    expect(attempt.callSid).toBe("CA-live");
    expect(h.sender.createCall).toHaveBeenCalledWith(expect.objectContaining({ to: PHONE, from: h.env.SI_ASSISTANT_NUMBER,
      url: expect.stringContaining("https://fleet.example/voice/si-assistant?contact="), statusCallbackEvent: ["initiated", "ringing", "answered", "completed"] }));
    expect((await h.outbound.callbackCandidates("si-assistant", PHONE)).candidates[0].lastAttemptAt).toEqual(h.clock.at);
    expect(await h.outbound.priorAttempts(contact.id)).toHaveLength(1);
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken })).status).toBe(409);
    expect(h.sender.createCall).toHaveBeenCalledTimes(1);
    const audit = JSON.stringify(await h.store.listAudit());
    for (const secret of [PHONE, "Testa", "private context", a.confirmToken, "1950"]) expect(audit).not.toContain(secret);
    h.sessions.drop(result.body.sessionId);
  });

  it.each(["sms", "email"] as const)("refuses a %s approval without consuming it", async (channel) => {
    const h = await boot(); const a = await h.approved(channel);
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken })).status).toBe(400);
    expect((await h.store.getApproval(a.id))?.confirmUsedAt).toBeNull();
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("requires the preparing bot, commit scope, writes, and a valid confirmation", async () => {
    const h = await boot(); const a = await h.approved();
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken }, h.staff)).status).toBe(403);
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken }, h.other)).status).toBe(404);
    h.env.PLUGIN_WRITES_ENABLED = "false";
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken })).status).toBe(403);
    h.env.PLUGIN_WRITES_ENABLED = "true";
    const missing = await h.request("/commit_call_live", { confirmToken: "a".repeat(64) });
    expect(missing.status).toBe(404); expect(missing.body).not.toHaveProperty("outcome");
    h.clock.at = new Date(h.clock.at.getTime() + CONFIRM_TTL_MS);
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken })).status).toBe(410);
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it.each(["sms_stop", "voice", "outside_hours", "holiday", "outbound_dialing_off", "campaign_off", "no_caller_id", "call_already_queued", "daily_cap", "total_cap", "payload_hash_mismatch"])("refuses %s after consumption with not_sent", async (reason) => {
    const h = await boot(); const a = await h.approved();
    if (reason === "sms_stop") await h.store.setSmsOptOut("5555550111", true);
    if (reason === "voice") await h.outbound.stampDoNotContact(PHONE, "voice");
    if (reason === "outside_hours") h.clock.at = new Date("2026-10-22T15:59:00Z");
    if (reason === "holiday") h.clock.at = new Date("2026-11-11T18:00:00Z");
    // Keep approval fresh while moving the policy clock.
    h.store.approvals.get(a.id)!.confirmExpiresAt = new Date(h.clock.at.getTime() + CONFIRM_TTL_MS);
    if (reason === "outbound_dialing_off") h.env.RUNTIME_OUTBOUND_DIALING = "0";
    if (reason === "campaign_off") h.env.OUTBOUND_CAMPAIGN_SI_ASSISTANT = "0";
    if (reason === "no_caller_id") h.env.SI_ASSISTANT_NUMBER = "";
    if (["call_already_queued", "daily_cap", "total_cap"].includes(reason)) {
      h.outbound.addContact({ id: "prior", phone: PHONE, externalRef: "plugin:prior", status: reason === "call_already_queued" ? "pending" : "completed" });
      if (reason !== "call_already_queued") {
        const dates = reason === "daily_cap" ? [OPEN] : ["2026-09-01T18:00:00Z", "2026-09-02T18:00:00Z", "2026-09-03T18:00:00Z"];
        for (const [i, at] of dates.entries()) h.outbound.attempts.push({ id: `p${i}`, contactId: "prior", campaignId: h.outbound.campaignId, attemptNumber: i + 1, at: new Date(at), endedAt: new Date(at) });
      }
    }
    if (reason === "payload_hash_mismatch") h.store.approvals.get(a.id)!.payload.purpose = "changed";
    const result = await h.request("/commit_call_live", { confirmToken: a.confirmToken });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.outcome).toBe("not_sent");
    expect((await h.store.getApproval(a.id))?.status).toBe("failed");
    expect((await h.store.getApproval(a.id))?.result?.reason).toBe(["sms_stop", "voice"].includes(reason) ? "do_not_contact" : reason);
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it.each([false, true])("classifies a Twilio error (clear refusal: %s) and never retries", async (clear) => {
    const h = await boot(); const a = await h.approved();
    h.sender.createCall.mockRejectedValue(clear ? Object.assign(new Error("private provider detail"), { name: "RestException", status: 400 }) : new Error("private provider detail"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await h.request("/commit_call_live", { confirmToken: a.confirmToken });
    expect(result.body.outcome).toBe(clear ? "not_sent" : "unknown");
    expect((await h.store.getApproval(a.id))?.status).toBe(clear ? "failed" : "unknown");
    expect(h.outbound.attempts[0].finish?.status).toBe(clear ? "not_placed" : undefined);
    // Even after the stale-claim sweep, these rows never enter the dialer.
    h.clock.at = new Date("2026-10-23T18:00:00Z");
    await h.outbound.reapStaleClaims(h.outbound.campaignId, h.clock.at, h.clock.at);
    const dial = vi.fn();
    await runCampaignTick("si-assistant", siAssistantPolicy, { store: h.outbound, env: h.env, host: "fleet.example", now: () => h.clock.at,
      twilio: { createCall: dial, voiceUrlFor: h.sender.voiceUrlFor } });
    expect(dial).not.toHaveBeenCalled();
    expect(h.sender.createCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private provider detail");
    for (const attempt of h.outbound.attempts) {
      const session = h.sessions.forCall(attempt.callSid ?? "");
      if (session) h.sessions.drop(session.sessionId);
    }
  });

  it("never treats an ended live call as queued, but still enforces its daily cap", async () => {
    const h = await boot(); const first = await h.approved();
    const placed = await h.request("/commit_call_live", { confirmToken: first.confirmToken });
    const contact = [...h.outbound.contacts.values()][0];
    await h.outbound.finishAttempt(h.outbound.attempts[0].id, { status: "no-answer" });
    await h.outbound.settleContact(contact.id, "no_answer");
    const second = await h.approved();
    const result = await h.request("/commit_call_live", { confirmToken: second.confirmToken });
    expect(result.body).toMatchObject({ outcome: "not_sent", error: expect.stringContaining("daily_cap") });
    expect(h.sender.createCall).toHaveBeenCalledTimes(1);
    h.sessions.drop(placed.body.sessionId);
  });

  it("serializes simultaneous live commits before the per-number checks", async () => {
    const h = await boot(); const first = await h.approved(); const second = await h.approved();
    const results = await Promise.all([h.request("/commit_call_live", { confirmToken: first.confirmToken }), h.request("/commit_call_live", { confirmToken: second.confirmToken })]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.find((r) => r.status !== 200)?.body.outcome).toBe("not_sent");
    expect(h.sender.createCall).toHaveBeenCalledTimes(1);
  });

  it("returns unknown when Twilio accepts but the approval commit write fails", async () => {
    const h = await boot(); const a = await h.approved();
    const update = h.store.updateApproval.bind(h.store);
    vi.spyOn(h.store, "updateApproval").mockImplementation((id, patch, status) => {
      if (patch.status === "committed") throw new Error("database unavailable");
      return update(id, patch, status);
    });
    const result = await h.request("/commit_call_live", { confirmToken: a.confirmToken });
    expect(result).toMatchObject({ status: 502, body: { outcome: "unknown" } });
    expect((await h.store.getApproval(a.id))?.status).toBe("unknown");
    expect(h.sender.createCall).toHaveBeenCalledTimes(1);
  });

  it("bounds an ambiguous Twilio timeout and never retries it", async () => {
    vi.useFakeTimers();
    try {
      const h = await boot(); const a = await h.approved();
      h.sender.createCall.mockImplementation(() => new Promise(() => {}));
      const pending = h.request("/commit_call_live", { confirmToken: a.confirmToken });
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await pending).toMatchObject({ status: 502, body: { outcome: "unknown" } });
      expect(h.sender.createCall).toHaveBeenCalledTimes(1);
      expect((await h.store.getApproval(a.id))?.status).toBe("unknown");
    } finally { vi.useRealTimers(); }
  });

  it("owns polling, guidance and end controls, and drops transcripts after completion", async () => {
    const h = await boot(); const a = await h.approved();
    const live = await h.request("/commit_call_live", { confirmToken: a.confirmToken });
    const id = live.body.sessionId;
    expect((await h.request(`/live_calls/${id}`)).body.status).toBe("dialing");
    const instruct = vi.fn(); const end = vi.fn();
    const turns = [{ role: "agent" as const, text: "I am an AI", atMs: h.clock.at.getTime() }, { role: "caller" as const, text: "private transcript", atMs: h.clock.at.getTime() }];
    h.sessions.attach("CA-live", { turns: () => turns, instruct, end });
    expect((await h.request(`/live_calls/${id}?after=0`)).body).toMatchObject({ status: "in_progress", nextAfter: 1,
      transcript: [{ role: "caller", text: "private transcript", at: h.clock.at.toISOString() }] });
    expect((await h.request(`/live_calls/${id}?after=bad`)).status).toBe(400);
    for (const token of [h.other, h.staff]) {
      expect((await h.request(`/live_calls/${id}`, undefined, token)).status).toBe(token === h.staff ? 403 : 404);
      for (const action of ["instruct", "end"]) expect((await h.request(`/live_calls/${id}/${action}`, { text: "hi" }, token)).status).toBe(token === h.staff ? 403 : 404);
    }
    expect((await h.request(`/live_calls/${id}/instruct`, { text: "x".repeat(2001) })).status).toBe(400);
    expect((await h.request(`/live_calls/${id}/instruct`, { text: "private guidance" })).status).toBe(200);
    expect(instruct).toHaveBeenCalledWith("private guidance");
    h.env.PLUGIN_WRITES_ENABLED = "0";
    expect((await h.request(`/live_calls/${id}`)).status).toBe(403);
    h.env.PLUGIN_WRITES_ENABLED = "true";
    expect((await h.request(`/live_calls/${id}/end`, {})).status).toBe(200);
    expect(h.sender.endCall).toHaveBeenCalledWith("CA-live"); expect(end).toHaveBeenCalledOnce();
    expect((await h.request(`/live_calls/${id}`)).body).toMatchObject({ status: "completed", endedAt: h.clock.at.toISOString(), transcript: expect.any(Array) });
    expect((await h.request(`/live_calls/${id}/instruct`, { text: "hi" })).status).toBe(409);
    expect(JSON.stringify(await h.store.listAudit())).not.toMatch(/private transcript|private guidance/);
    h.clock.at = new Date(h.clock.at.getTime() + LIVE_RETENTION_MS);
    expect((await h.request(`/live_calls/${id}`)).status).toBe(404);
  });
});

describe("approved SMS hours", () => {
  it.each([
    ["2026-10-22T15:59:59Z", "outside_hours"], ["2026-10-23T03:00:00Z", "outside_hours"],
    ["2026-11-11T18:00:00Z", "holiday"], ["2026-11-27T18:00:00Z", "holiday"],
    ["2026-11-02T16:59:59Z", "outside_hours"],
  ])("refuses %s before sending with %s and commit outcome not_sent", async (date, reason) => {
    const h = await boot(); h.clock.at = new Date(date); const a = await h.approved("sms");
    expect(await sendApprovedSms(h.store, h.sms, { phone: PHONE, body: "hi" }, h.env, h.clock.at)).toEqual({ ok: false, reason, mayHaveSent: false });
    const result = await h.request("/commit_contact", { confirmToken: a.confirmToken });
    expect(result.body.outcome).toBe("not_sent");
    expect((await h.store.getApproval(a.id))?.result?.reason).toBe(reason);
    expect(h.sms.send).not.toHaveBeenCalled();
  });

  it.each(["2026-10-22T16:00:00Z", "2026-10-23T02:59:59Z", "2026-11-02T17:00:00Z"])("sends within the Pacific window at %s", async (date) => {
    const h = await boot(); h.clock.at = new Date(date);
    expect(await sendApprovedSms(h.store, h.sms, { phone: PHONE, body: "hi" }, h.env, h.clock.at)).toEqual({ ok: true, sid: "SM-test" });
  });

  it("uses practice closure dates for SMS and live calls", async () => {
    const closures = PRACTICE_CLOSURES as string[];
    closures.push("2026-10-22");
    try {
      const h = await boot(); const sms = await h.approved("sms"); const call = await h.approved();
      for (const [path, approval] of [["/commit_contact", sms], ["/commit_call_live", call]] as const) {
        const result = await h.request(path, { confirmToken: approval.confirmToken });
        expect(result.body).toMatchObject({ outcome: "not_sent", error: expect.stringContaining("closed_day") });
      }
      expect(h.sms.send).not.toHaveBeenCalled(); expect(h.sender.createCall).not.toHaveBeenCalled();
    } finally { closures.pop(); }
  });

  it("continues replying to STOP, HELP and START outside hours and on holidays", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-11T06:00:00Z"));
    try {
      const store = new MemoryPluginStore(); const sender = { send: vi.fn().mockResolvedValue({ sid: "SM" }) };
      for (const body of ["STOP", "HELP", "START"]) expect((await handleInboundSms(store, sender, { from: PHONE, body }, {})).replied).toBe(true);
      expect(sender.send).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});
