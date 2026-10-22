/**
 * Plugin API: approval gate, calling window, DNC, token expiry, no PHI
 * in audit or ticket-resolved logs. In-memory store only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { MemoryPluginStore } from "./store";
import { mountPluginApi } from "./routes";
import { createGraphMail, createMemoryGraphMail } from "./email";
import { evaluateAndEnqueueCall, siAssistantMayDial } from "./callEnqueue";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";
import { auditContainsPhi, ticketResolvedLogFields } from "./phi";
import { ticketResolvedAuthorized } from "./ticketResolved";
import { CONFIRM_TTL_MS } from "./tokens";
import { classifyInboundSms, handleInboundSms, sendApprovedSms } from "./sms";
import { SI_ASSISTANT_EMAIL_DEFAULT } from "./siAssistantConstants";

const PHONE = "+15555550111";
const TICKET = "VA-61001";

function agents() {
  return {
    getAllAgents: () => [
      {
        id: "si-assistant",
        description: "SI Assistant",
        agentType: "outbound" as const,
        enabled: true,
        version: "1.0.0",
      },
    ],
  };
}

async function listen(
  env: Record<string, string | undefined>,
  extras: {
    store?: MemoryPluginStore;
    outbound?: FakeOutboundStore;
    sms?: Array<{ to: string; from: string; body: string }>;
    mail?: ReturnType<typeof createMemoryGraphMail>;
    now?: () => Date;
  } = {},
): Promise<{
  base: string;
  server: Server;
  store: MemoryPluginStore;
  outbound: FakeOutboundStore;
  sms: Array<{ to: string; from: string; body: string }>;
  mail: ReturnType<typeof createMemoryGraphMail>;
}> {
  const store = extras.store ?? new MemoryPluginStore();
  const outbound = extras.outbound ?? new FakeOutboundStore();
  const sms = extras.sms ?? [];
  const mail = extras.mail ?? createMemoryGraphMail();
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  mountPluginApi(app, {
    store,
    agents: agents(),
    env,
    now: extras.now,
    outboundStore: outbound,
    smsSender: {
      async send(opts) {
        sms.push(opts);
        return { sid: `SM${sms.length}` };
      },
    },
    graphMail: mail,
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, server, store, outbound, sms, mail };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    if (s) await close(s);
  }
});

async function boot(env: Record<string, string | undefined>, extras?: Parameters<typeof listen>[1]) {
  const ctx = await listen(env, extras);
  servers.push(ctx.server);
  return ctx;
}

describe("plugin auth", () => {
  it("rejects a missing bearer token", async () => {
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" });
    store.mint(["fleet:read"]);
    const res = await fetch(`${base}/api/plugin/v1/list_agents`);
    expect(res.status).toBe(401);
  });

  it("rejects a token whose secret does not match the hash", async () => {
    const { base, store } = await boot({});
    const minted = store.mint(["fleet:read"]);
    const [prefix, jti] = minted.plaintext.split(".");
    const res = await fetch(`${base}/api/plugin/v1/list_agents`, {
      headers: { Authorization: `Bearer ${prefix}.${jti}.${"0".repeat(64)}` },
    });
    expect(res.status).toBe(401);
  });

  it("lists agents with fleet:read", async () => {
    const { base, store } = await boot({});
    const minted = store.mint(["fleet:read"]);
    const res = await fetch(`${base}/api/plugin/v1/list_agents`, {
      headers: { Authorization: `Bearer ${minted.plaintext}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ id: string }> };
    expect(body.agents.map((a) => a.id)).toContain("si-assistant");
  });
});

describe("the approval gate", () => {
  it("refuses writes when PLUGIN_WRITES_ENABLED is unset", async () => {
    const { base, store, outbound } = await boot({});
    const minted = store.mint(["contacts:prepare"]);
    const res = await fetch(`${base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${minted.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET }),
    });
    expect(res.status).toBe(403);
    expect(outbound.upserts).toEqual([]);
  });

  it("prepare_call creates a pending row and does not dial", async () => {
    const { base, store, outbound } = await boot({ PLUGIN_WRITES_ENABLED: "true" });
    const minted = store.mint(["contacts:prepare"]);
    const res = await fetch(`${base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${minted.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, firstName: "Testa" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      confirmToken?: string;
      approval: { id: string; status: string; confirmExpiresAt?: string | null };
    };
    expect(body.status).toBe("pending_approval");
    expect(body.approval.status).toBe("pending");
    expect(body.confirmToken).toBeUndefined();
    expect(body.approval.confirmExpiresAt ?? null).toBeNull();
    expect(outbound.upserts).toEqual([]);
    expect(body.approval).not.toHaveProperty("phone");
  });

  it("commit_contact without an approve is refused", async () => {
    const { base, store, outbound } = await boot({ PLUGIN_WRITES_ENABLED: "true" });
    const prepared = store.mint(["contacts:prepare"]);
    const committer = store.mint(["contacts:commit"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${prepared.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, body: "Please call us", ticketNumber: TICKET }),
    });
    expect(prep.status).toBe(201);
    const res = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${committer.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: "a".repeat(64) }),
    });
    expect(res.status).toBe(404);
    expect(outbound.upserts).toEqual([]);
  });

  it("approve then commit places one call into the campaign queue", async () => {
    const now = () => new Date("2026-10-22T18:00:00Z"); // 11:00 Pacific
    const { base, store, outbound } = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { now });
    const bot = store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = store.mint(["contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, firstName: "Testa" }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await fetch(`${base}/api/plugin/v1/approvals/${pending.approval.id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${staff.plaintext}`, "Content-Type": "application/json" },
    });
    expect(approved.status).toBe(200);
    const token = (await approved.json()) as { confirmToken: string };
    const committed = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(committed.status).toBe(200);
    const body = (await committed.json()) as { status: string; result: { queued: boolean } };
    expect(body.status).toBe("committed");
    expect(body.result.queued).toBe(true);
    expect(outbound.upserts).toEqual([1]);
  });

  it("a used confirm token cannot be reused", async () => {
    const now = () => new Date("2026-10-22T18:00:00Z");
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { now });
    const bot = store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = store.mint(["contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, body: "Hello", ticketNumber: TICKET }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await fetch(`${base}/api/plugin/v1/approvals/${pending.approval.id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${staff.plaintext}` },
    });
    const token = (await approved.json()) as { confirmToken: string };
    const first = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(second.status).toBe(409);
  });
});

describe("token expiry", () => {
  it("mints the confirm token at approve, so a request that sat pending longer than five minutes still commits", async () => {
    let nowMs = Date.parse("2026-10-22T18:00:00Z");
    const { base, store, outbound } = await boot(
      { PLUGIN_WRITES_ENABLED: "true" },
      { now: () => new Date(nowMs) },
    );
    const bot = store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = store.mint(["contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, firstName: "Testa" }),
    });
    const pending = (await prep.json()) as {
      confirmToken?: string;
      approval: { id: string; confirmExpiresAt?: string | null };
    };
    expect(pending.confirmToken).toBeUndefined();
    expect(pending.approval.confirmExpiresAt ?? null).toBeNull();

    nowMs += CONFIRM_TTL_MS + 60_000;
    const approved = await fetch(`${base}/api/plugin/v1/approvals/${pending.approval.id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${staff.plaintext}` },
    });
    expect(approved.status).toBe(200);
    const token = (await approved.json()) as { confirmToken: string; expiresAt: string };
    expect(token.confirmToken).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(token.expiresAt)).toBe(nowMs + CONFIRM_TTL_MS);

    const committed = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(committed.status).toBe(200);
    expect(outbound.upserts).toEqual([1]);
  });

  it("refuses a confirm token after five minutes", async () => {
    let nowMs = Date.parse("2026-10-22T18:00:00Z");
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { now: () => new Date(nowMs) });
    const bot = store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = store.mint(["contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "patient@example.com",
        subject: "Follow up",
        body: "Please reply",
        ticketNumber: TICKET,
      }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await fetch(`${base}/api/plugin/v1/approvals/${pending.approval.id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${staff.plaintext}` },
    });
    const token = (await approved.json()) as { confirmToken: string };
    nowMs += CONFIRM_TTL_MS + 1;
    const committed = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(committed.status).toBe(410);
    const body = (await committed.json()) as { error: string };
    expect(body.error).toMatch(/expired/i);
  });
});

describe("the calling window and DNC list", () => {
  it("blocks a call outside 9 AM–8 PM Pacific", () => {
    // 8:30 AM PDT on a Thursday.
    const early = siAssistantMayDial(new Date("2026-10-22T15:30:00Z"), []);
    expect(early).toEqual({ ok: false, reason: "outside_hours" });
    // 8:00 PM PDT — endHour is the first hour that may not start.
    const late = siAssistantMayDial(new Date("2026-10-23T03:00:00Z"), []);
    expect(late).toEqual({ ok: false, reason: "outside_hours" });
    const ok = siAssistantMayDial(new Date("2026-10-22T18:00:00Z"), []);
    expect(ok).toEqual({ ok: true });
  });

  it("blocks a second call the same Pacific day", () => {
    const noon = new Date("2026-10-22T19:00:00Z");
    const again = siAssistantMayDial(noon, [{ at: new Date("2026-10-22T18:00:00Z") }]);
    expect(again).toEqual({ ok: false, reason: "daily_cap" });
  });

  it("does not enqueue a number on the do-not-contact list", async () => {
    const outbound = new FakeOutboundStore();
    await outbound.stampDoNotContact(PHONE, "opt_out_of_calls");
    const result = await evaluateAndEnqueueCall(
      outbound,
      { approvalId: "appr-1", phone: PHONE, ticketNumber: TICKET },
      new Date("2026-10-22T18:00:00Z"),
    );
    expect(result).toEqual({ ok: false, reason: "do_not_contact" });
    expect(outbound.upserts).toEqual([]);
  });

  it("commit_contact reports DNC as 409 and writes nothing", async () => {
    const outbound = new FakeOutboundStore();
    await outbound.stampDoNotContact(PHONE, "opt_out_of_calls");
    const now = () => new Date("2026-10-22T18:00:00Z");
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { outbound, now });
    const bot = store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = store.mint(["contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await fetch(`${base}/api/plugin/v1/approvals/${pending.approval.id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${staff.plaintext}` },
    });
    const token = (await approved.json()) as { confirmToken: string };
    const committed = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(committed.status).toBe(409);
    expect(outbound.upserts).toEqual([]);
  });
});

describe("audit and ticket-resolved logs hold no PHI", () => {
  it("writes audit rows without phones, bodies or names", async () => {
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" });
    const minted = store.mint(["contacts:prepare"]);
    await fetch(`${base}/api/plugin/v1/prepare_sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${minted.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, body: "Patient secret text", ticketNumber: TICKET }),
    });
    const audit = await store.listAudit();
    expect(audit.length).toBeGreaterThan(0);
    for (const row of audit) {
      expect(auditContainsPhi(row as unknown as Record<string, unknown>)).toBe(false);
      expect(JSON.stringify(row)).not.toContain("5555550111");
      expect(JSON.stringify(row)).not.toContain("Patient secret");
    }
  });

  it("ticket-resolved log fields drop names, phones and notes", () => {
    const logged = ticketResolvedLogFields({
      ticketId: "t-1",
      ticketNumber: TICKET,
      preferredContactMethod: "phone",
    });
    expect(logged).toEqual({ ticketId: "t-1", ticketNumber: TICKET, contactMethod: "phone" });
    expect(auditContainsPhi(logged)).toBe(false);
    expect(logged).not.toHaveProperty("phone");
    expect(logged).not.toHaveProperty("patientFirstName");
  });

  it("ticket-resolved auth is a miss when the secret is wrong or missing", () => {
    expect(ticketResolvedAuthorized("abc", "abc")).toBe(true);
    expect(ticketResolvedAuthorized("abd", "abc")).toBe(false);
    expect(ticketResolvedAuthorized("ab", "abc")).toBe(false);
    expect(ticketResolvedAuthorized(undefined, "abc")).toBe(false);
    expect(ticketResolvedAuthorized("abc", undefined)).toBe(false);
  });

  it("the ticket-resolved route uses the constant-time compare and the redacted log", () => {
    const src = readFileSync(join(__dirname, "../../server/routes.ts"), "utf8");
    expect(src).toMatch(/ticketResolvedAuthorized/);
    expect(src).toMatch(/ticketResolvedLogPayload/);
    expect(src).not.toMatch(/patient: `\$\{patientFirstName\}/);
    expect(src).not.toMatch(/providedApiKey !== expectedApiKey/);
  });
});

describe("SMS and email", () => {
  it("prefixes the AI identification and honours STOP", async () => {
    const store = new MemoryPluginStore();
    const sent: Array<{ to: string; from: string; body: string }> = [];
    const sender = {
      async send(opts: { to: string; from: string; body: string }) {
        sent.push(opts);
        return { sid: "SM1" };
      },
    };
    const out = await sendApprovedSms(store, sender, { phone: PHONE, body: "Your request is in." }, {});
    expect(out).toMatchObject({ ok: true });
    expect(sent[0].body.startsWith("Azul Vision SI Assistant (AI):")).toBe(true);
    expect(classifyInboundSms("STOP")).toBe("stop");
    await handleInboundSms(store, sender, { from: PHONE, body: "STOP" }, {});
    expect(await store.isSmsOptedOut("5555550111")).toBe(true);
    const blocked = await sendApprovedSms(store, sender, { phone: PHONE, body: "again" }, {});
    expect(blocked).toEqual({ ok: false, reason: "sms_opted_out" });
  });

  it("does not construct Graph mail without SI_MAIL_* credentials", () => {
    expect(createGraphMail({})).toBeNull();
    expect(
      createGraphMail({
        SI_MAIL_TENANT_ID: "tenant",
        SI_MAIL_CLIENT_ID: "client",
      }),
    ).toBeNull();
  });

  it("sends Graph mail from SI_ASSISTANT_EMAIL with SI_MAIL_* client credentials", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(url).includes("/oauth2/")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      return new Response("", { status: 202, headers: { "request-id": "rid-1" } });
    }) as typeof fetch;
    const mail = createGraphMail(
      {
        SI_MAIL_TENANT_ID: "tenant-id",
        SI_MAIL_CLIENT_ID: "client-id",
        SI_MAIL_CLIENT_SECRET: "secret-value",
      },
      fetchImpl,
    );
    expect(mail).not.toBeNull();
    const sent = await mail!.sendMail({ to: "patient@example.com", subject: "Hi", body: "Body" });
    expect(sent.id).toBe("rid-1");
    expect(calls[0].url).toBe("https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token");
    expect(calls[0].body).toContain("client_id=client-id");
    expect(calls[0].body).toContain("client_secret=secret-value");
    expect(calls[0].body).toContain("grant_type=client_credentials");
    expect(calls[1].url).toBe(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SI_ASSISTANT_EMAIL_DEFAULT)}/sendMail`,
    );
  });

  it("never hardcodes the Entra app id or a mail secret", () => {
    const files = [
      readFileSync(join(__dirname, "email.ts"), "utf8"),
      readFileSync(join(__dirname, "siAssistantConstants.ts"), "utf8"),
      readFileSync(join(__dirname, "../../docs/plugin-api.md"), "utf8"),
      readFileSync(join(__dirname, "../../.env.example"), "utf8"),
    ];
    for (const src of files) {
      expect(src).not.toMatch(/SI_MAIL_CLIENT_SECRET\s*=\s*['\"][^'\"]+['\"]/);
      expect(src).not.toMatch(/^SI_MAIL_CLIENT_SECRET=.+$/m);
    }
    expect(files[0]).not.toContain("f9cdfde5-7685-42bc-a0dd-32e5c16bf4e3");
    expect(files[1]).not.toContain("f9cdfde5-7685-42bc-a0dd-32e5c16bf4e3");
    expect(files[1]).toContain(SI_ASSISTANT_EMAIL_DEFAULT);
    expect(files[2]).toContain("SI_MAIL_TENANT_ID=");
    expect(files[2]).toContain("SI_MAIL_CLIENT_ID=");
    expect(files[2]).toContain("SI_MAIL_CLIENT_SECRET=");
    expect(files[2]).toContain("SI_ASSISTANT_EMAIL=");
    expect(files[3]).toContain("SI_MAIL_TENANT_ID=");
    expect(files[3]).toContain("SI_MAIL_CLIENT_ID=");
    expect(files[3]).toContain("SI_MAIL_CLIENT_SECRET=");
    expect(files[3]).toContain("SI_ASSISTANT_EMAIL=");
    expect(files[3]).toMatch(/^SI_MAIL_CLIENT_SECRET=$/m);
    expect(files[3]).toMatch(/^SI_MAIL_TENANT_ID=$/m);
    expect(files[3]).toMatch(/^SI_MAIL_CLIENT_ID=$/m);
  });
});
