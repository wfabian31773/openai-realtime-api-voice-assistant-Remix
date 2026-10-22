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
import twilio from "twilio";
import { MemoryPluginStore } from "./store";
import { mountPluginApi } from "./routes";
import { createGraphMail, createMemoryGraphMail, type GraphMail } from "./email";
import { evaluateAndEnqueueCall, siAssistantMayDial } from "./callEnqueue";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";
import { auditContainsPhi, ticketResolvedLogFields } from "./phi";
import { ticketResolvedAuthorized } from "./ticketResolved";
import { CONFIRM_TTL_MS, generateConfirmToken, hashPayload } from "./tokens";
import { classifyInboundSms, handleInboundSms, sendApprovedSms } from "./sms";
import { SI_ASSISTANT_EMAIL_DEFAULT } from "./siAssistantConstants";
import { mintScopesCompatible } from "./scopes";
import { createSqlPluginStore } from "./sqlStore";
import { extrasFromContactData, reportSiAssistantCall } from "./callbackReport";
import { markCommitted, markFailed, reapStaleSending } from "./approvals";
import { STALE_SENDING_MS } from "./store";
import type { SmsSender } from "./sms";

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
    smsSender?: SmsSender | null;
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
    smsSender:
      extras.smsSender !== undefined
        ? extras.smsSender
        : {
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

async function staffApprove(
  base: string,
  staff: { plaintext: string },
  store: MemoryPluginStore,
  id: string,
): Promise<Response> {
  const row = await store.getApproval(id);
  return fetch(`${base}/api/plugin/v1/approvals/${id}/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${staff.plaintext}`, "Content-Type": "application/json" },
    body: JSON.stringify({ payloadHash: row!.payloadHash }),
  });
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
    const approved = await staffApprove(base, staff, store, pending.approval.id);
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
    const approved = await staffApprove(base, staff, store, pending.approval.id);
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
    const approved = await staffApprove(base, staff, store, pending.approval.id);
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
    const approved = await staffApprove(base, staff, store, pending.approval.id);
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
    const approved = await staffApprove(base, staff, store, pending.approval.id);
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
    expect(blocked).toEqual({ ok: false, reason: "sms_opted_out", mayHaveSent: false });
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
    const signals: Array<AbortSignal | undefined> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
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
    expect(signals[0]).toBeDefined();
    expect(signals[1]).toBeDefined();
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(false);
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

const TWILIO_AUTH = "test-auth-token";

function signedSms(path: string, body: Record<string, string>, host = "127.0.0.1") {
  const url = `http://${host}${path}`;
  const sig = (
    twilio as unknown as {
      getExpectedTwilioSignature: (t: string, u: string, p: Record<string, string>) => string;
    }
  ).getExpectedTwilioSignature(TWILIO_AUTH, url, body);
  return { signature: sig, body };
}

describe("review findings", () => {
  it("refuses an unsigned SMS STOP and does not write DNC", async () => {
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true", TWILIO_AUTH_TOKEN: TWILIO_AUTH });
    const res = await fetch(`${base}/api/plugin/v1/webhooks/twilio-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: PHONE, Body: "STOP" }).toString(),
    });
    expect(res.status).toBe(403);
    expect(await store.isSmsOptedOut("5555550111")).toBe(false);
  });

  it("fails closed on SMS STOP when TWILIO_AUTH_TOKEN is missing", async () => {
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" });
    const res = await fetch(`${base}/api/plugin/v1/webhooks/twilio-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: PHONE, Body: "STOP" }).toString(),
    });
    expect(res.status).toBe(200);
    expect(await store.isSmsOptedOut("5555550111")).toBe(false);
  });

  it("honours a signed SMS STOP", async () => {
    const { base, store, server } = await boot({
      PLUGIN_WRITES_ENABLED: "true",
      TWILIO_AUTH_TOKEN: TWILIO_AUTH,
    });
    const port = (server.address() as { port: number }).port;
    const path = "/api/plugin/v1/webhooks/twilio-sms";
    const body = { From: PHONE, Body: "STOP" };
    const signed = signedSms(path, body, `127.0.0.1:${port}`);
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signed.signature,
      },
      body: new URLSearchParams(body).toString(),
    });
    expect(res.status).toBe(200);
    expect(await store.isSmsOptedOut("5555550111")).toBe(true);
  });

  it("claims a confirm token only once under overlapping commits", async () => {
    const store = new MemoryPluginStore();
    const token = generateConfirmToken();
    const now = new Date("2026-10-22T18:00:00Z");
    await store.insertApproval({
      id: "appr-race",
      channel: "sms",
      status: "approved",
      tokenJti: "preparer",
      ticketId: null,
      ticketNumber: TICKET,
      payload: { phone: PHONE, body: "Hi" },
      payloadHash: hashPayload({ phone: PHONE, body: "Hi" }),
      confirmTokenHash: token.hash,
      confirmExpiresAt: new Date(now.getTime() + 60_000),
      confirmUsedAt: null,
      approvedBy: "staff",
      approvedAt: now,
      rejectedBy: null,
      rejectedAt: null,
      cancelledAt: null,
      committedAt: null,
      result: null,
      createdAt: now,
      updatedAt: now,
    });
    const [a, b] = await Promise.all([
      store.claimConfirmToken(token.hash, now),
      store.claimConfirmToken(token.hash, now),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("the SQL claim is one conditional UPDATE", async () => {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    const store = createSqlPluginStore(async (text, params) => {
      seen.push({ text, params: params ?? [] });
      return [];
    });
    await store.claimConfirmToken("abc", new Date("2026-10-22T18:00:00Z"));
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toMatch(/confirm_used_at IS NULL/);
    expect(seen[0].text).toMatch(/status = 'approved'/);
    expect(seen[0].text).toMatch(/status = 'sending'/);
    expect(seen[0].text).toMatch(/confirm_expires_at > \$2/);
    expect(seen[0].text).toMatch(/RETURNING \*/);
  });

  it("shows the payload and hash to the approver and refuses a mismatched hash", async () => {
    const now = () => new Date("2026-10-22T18:00:00Z");
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { now });
    const bot = store.mint(["contacts:prepare"]);
    const staff = store.mint(["contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, body: "Please call us", ticketNumber: TICKET }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const listed = await fetch(`${base}/api/plugin/v1/approvals`, {
      headers: { Authorization: `Bearer ${staff.plaintext}` },
    });
    const body = (await listed.json()) as {
      approvals: Array<{ id: string; payload: { body: string; phone: string }; payloadHash: string }>;
    };
    const shown = body.approvals.find((r) => r.id === pending.approval.id);
    expect(shown?.payload.body).toBe("Please call us");
    expect(shown?.payload.phone).toBe(PHONE);
    expect(shown?.payloadHash).toMatch(/^[a-f0-9]{64}$/);

    const wrong = await fetch(`${base}/api/plugin/v1/approvals/${pending.approval.id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${staff.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ payloadHash: "0".repeat(64) }),
    });
    expect(wrong.status).toBe(409);

    const ok = await fetch(`${base}/api/plugin/v1/approvals/${pending.approval.id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${staff.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ payloadHash: shown!.payloadHash }),
    });
    expect(ok.status).toBe(200);
  });

  it("refuses a token approving its own request", async () => {
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" });
    const both = store.mint(["contacts:prepare", "contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${both.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, body: "Hi", ticketNumber: TICKET }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await staffApprove(base, both, store, pending.approval.id);
    expect(approved.status).toBe(403);
    expect(mintScopesCompatible(["contacts:prepare", "contacts:approve"]).ok).toBe(false);
    expect(mintScopesCompatible(["fleet:read", "contacts:approve"]).ok).toBe(true);
  });

  it("marks a Twilio 4xx before accept as failed, not unknown", async () => {
    const now = () => new Date("2026-10-22T18:00:00Z");
    const { base, store } = await boot(
      { PLUGIN_WRITES_ENABLED: "true" },
      {
        now,
        smsSender: {
          async send() {
            const err = Object.assign(new Error("21614"), { status: 400 });
            throw err;
          },
        },
      },
    );
    const bot = store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = store.mint(["contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, body: "Patient secret text", ticketNumber: TICKET }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await staffApprove(base, staff, store, pending.approval.id);
    const token = (await approved.json()) as { confirmToken: string };
    const committed = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(committed.status).toBe(409);
    const row = await store.getApproval(pending.approval.id);
    expect(row?.status).toBe("failed");
    expect(row?.result).toEqual({ reason: "rejected" });
  });

  it("marks a Graph 4xx and a token-fetch failure as failed", async () => {
    const { SendOutcomeError } = await import("./sendFailure");
    const now = () => new Date("2026-10-22T18:00:00Z");
    for (const err of [new SendOutcomeError("graph_token_failed", false), new SendOutcomeError("graph_send_failed", false)]) {
      const { base, store } = await boot(
        { PLUGIN_WRITES_ENABLED: "true" },
        {
          now,
          mail: {
            sent: [],
            async sendMail() {
              throw err;
            },
            async listReplies() {
              return [];
            },
          } as ReturnType<typeof createMemoryGraphMail>,
        },
      );
      const bot = store.mint(["contacts:prepare", "contacts:commit"]);
      const staff = store.mint(["contacts:approve"]);
      const prep = await fetch(`${base}/api/plugin/v1/prepare_email`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
        body: JSON.stringify({ to: "a@example.com", subject: "Hi", body: "Patient secret", ticketNumber: TICKET }),
      });
      const pending = (await prep.json()) as { approval: { id: string } };
      const approved = await staffApprove(base, staff, store, pending.approval.id);
      const token = (await approved.json()) as { confirmToken: string };
      const committed = await fetch(`${base}/api/plugin/v1/commit_contact`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
        body: JSON.stringify({ confirmToken: token.confirmToken }),
      });
      expect(committed.status).toBe(409);
      const row = await store.getApproval(pending.approval.id);
      expect(row?.status).toBe("failed");
      expect((row?.result as { reason?: string })?.reason).toBe(err.reason);
    }
  });

  it("moves a thrown send to unknown and audits without PHI", async () => {
    const now = () => new Date("2026-10-22T18:00:00Z");
    const { base, store } = await boot(
      { PLUGIN_WRITES_ENABLED: "true" },
      {
        now,
        smsSender: {
          async send() {
            throw new Error(`twilio refused ${PHONE} Patient secret text`);
          },
        },
      },
    );
    const bot = store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = store.mint(["contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, body: "Patient secret text", ticketNumber: TICKET }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await staffApprove(base, staff, store, pending.approval.id);
    const token = (await approved.json()) as { confirmToken: string };
    const committed = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(committed.status).toBe(502);
    const row = await store.getApproval(pending.approval.id);
    expect(row?.status).toBe("unknown");
    expect(row?.result).toEqual({ reason: "unknown" });
    const audit = await store.listAudit();
    const unknown = audit.find((e) => e.outcome === "unknown" && e.tool === "commit_contact");
    expect(unknown).toBeTruthy();
    expect(JSON.stringify(unknown)).not.toContain("5555550111");
    expect(JSON.stringify(unknown)).not.toContain("Patient secret");
    expect(auditContainsPhi(unknown as unknown as Record<string, unknown>)).toBe(false);
  });

  it("will not send a cancelled request and will not overwrite cancelled", async () => {
    const now = () => new Date("2026-10-22T18:00:00Z");
    const { base, store, sms } = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { now });
    const bot = store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = store.mint(["contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, body: "Hello", ticketNumber: TICKET }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await staffApprove(base, staff, store, pending.approval.id);
    const token = (await approved.json()) as { confirmToken: string };
    const cancelled = await fetch(`${base}/api/plugin/v1/cancel_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: pending.approval.id }),
    });
    expect(cancelled.status).toBe(200);
    const committed = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect([404, 409]).toContain(committed.status);
    expect(sms).toEqual([]);
    const row = await store.getApproval(pending.approval.id);
    expect(row?.status).toBe("cancelled");
  });

  it("refuses cancel after the confirm token is consumed", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const token = generateConfirmToken();
    await store.insertApproval({
      id: "appr-used",
      channel: "sms",
      status: "approved",
      tokenJti: "preparer",
      ticketId: null,
      ticketNumber: TICKET,
      payload: { phone: PHONE, body: "Hi" },
      payloadHash: hashPayload({ phone: PHONE, body: "Hi" }),
      confirmTokenHash: token.hash,
      confirmExpiresAt: new Date(now.getTime() + 60_000),
      confirmUsedAt: now,
      approvedBy: "staff",
      approvedAt: now,
      rejectedBy: null,
      rejectedAt: null,
      cancelledAt: null,
      committedAt: null,
      result: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(await store.cancelIfOpen("appr-used", now)).toBeNull();
    const committed = await store.updateApproval(
      "appr-used",
      { status: "committed", committedAt: now, result: { queued: true }, updatedAt: now },
      "approved",
    );
    expect(committed?.status).toBe("committed");
  });

  it("does not let another approval's attempts cap a first call", async () => {
    const outbound = new FakeOutboundStore();
    const campaignId = await outbound.ensureCampaign();
    await outbound.upsertSourceContacts(campaignId!, [
      {
        externalRef: "plugin:other-approval",
        phone: PHONE,
        firstName: "Other",
        lastName: null,
        data: {},
      },
    ]);
    const other = (await outbound.sourceRows(campaignId!))[0];
    const attemptId = await outbound.startAttempt(other.id, campaignId!, 1);
    await outbound.finishAttempt(attemptId, { status: "no_answer" });
    const result = await evaluateAndEnqueueCall(
      outbound,
      { approvalId: "new-approval", phone: PHONE, ticketNumber: TICKET },
      new Date("2026-10-22T18:00:00Z"),
    );
    expect(result).toMatchObject({ ok: true, queued: true });
  });

  it("returns 422 outside hours and 503 when the campaign is missing", async () => {
    const now = () => new Date("2026-10-22T15:30:00Z"); // 8:30 AM PDT
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { now });
    const bot = store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = store.mint(["contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await staffApprove(base, staff, store, pending.approval.id);
    const token = (await approved.json()) as { confirmToken: string };
    const committed = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(committed.status).toBe(422);

    const outbound = new FakeOutboundStore();
    outbound.agentRowMissing = true;
    const noon = () => new Date("2026-10-22T18:00:00Z");
    const missing = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { outbound, now: noon });
    const bot2 = missing.store.mint(["contacts:prepare", "contacts:commit"]);
    const staff2 = missing.store.mint(["contacts:approve"]);
    const prep2 = await fetch(`${missing.base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot2.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET }),
    });
    const pending2 = (await prep2.json()) as { approval: { id: string } };
    const approved2 = await staffApprove(missing.base, staff2, missing.store, pending2.approval.id);
    const token2 = (await approved2.json()) as { confirmToken: string };
    const committed2 = await fetch(`${missing.base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot2.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token2.confirmToken }),
    });
    expect(committed2.status).toBe(503);
  });

  it("hides another token's request and drops unknown prepare keys", async () => {
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" });
    const bot = store.mint(["contacts:prepare", "fleet:read"]);
    const other = store.mint(["contacts:prepare", "fleet:read"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: PHONE,
        body: "Hello",
        ticketNumber: TICKET,
        ssn: "000-00-0000",
        extra: "drop me",
      }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const row = await store.getApproval(pending.approval.id);
    expect(row?.payload).not.toHaveProperty("ssn");
    expect(row?.payload).not.toHaveProperty("extra");
    expect(row?.tokenJti).toBe(bot.jti);

    const peek = await fetch(`${base}/api/plugin/v1/get_contact_request?id=${pending.approval.id}`, {
      headers: { Authorization: `Bearer ${other.plaintext}` },
    });
    expect(peek.status).toBe(404);
    const cancel = await fetch(`${base}/api/plugin/v1/cancel_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${other.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: pending.approval.id }),
    });
    expect(cancel.status).toBe(404);
  });

  it("redacts reply senders from fleet:read and catches Graph failures", async () => {
    const mail = createMemoryGraphMail();
    mail.listReplies = async () => [
      {
        id: "r1",
        receivedAt: "2026-10-22T18:00:00Z",
        conversationId: "c1",
        from: "patient@example.com",
        subject: "About my eyes",
      },
    ];
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { mail });
    const reader = store.mint(["fleet:read"]);
    const staff = store.mint(["contacts:approve", "fleet:read"]);
    const hidden = await fetch(`${base}/api/plugin/v1/email_replies`, {
      headers: { Authorization: `Bearer ${reader.plaintext}` },
    });
    const hiddenBody = (await hidden.json()) as { replies: Array<Record<string, unknown>> };
    expect(hiddenBody.replies[0]).not.toHaveProperty("from");
    expect(hiddenBody.replies[0]).not.toHaveProperty("subject");
    const shown = await fetch(`${base}/api/plugin/v1/email_replies`, {
      headers: { Authorization: `Bearer ${staff.plaintext}` },
    });
    const shownBody = (await shown.json()) as { replies: Array<{ from?: string; subject?: string }> };
    expect(shownBody.replies[0].from).toBe("patient@example.com");
    expect(shownBody.replies[0].subject).toBe("About my eyes");

    const broken: GraphMail = {
      async sendMail() {
        return { id: "x" };
      },
      async listReplies() {
        throw new Error("graph down");
      },
    };
    const fail = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { mail: broken as ReturnType<typeof createMemoryGraphMail> });
    const res = await fetch(`${fail.base}/api/plugin/v1/email_replies`, {
      headers: { Authorization: `Bearer ${fail.store.mint(["fleet:read"]).plaintext}` },
    });
    expect(res.status).toBe(502);
  });

  it("carries ticket id through the callback extras", async () => {
    const extras = extrasFromContactData({
      approval_id: "appr-1",
      ticket_number: TICKET,
      ticket_id: "tid-9",
    });
    expect(extras).toEqual({ approvalId: "appr-1", ticketNumber: TICKET, ticketId: "tid-9" });
    const posted: Array<{ body: string }> = [];
    await reportSiAssistantCall(
      {
        slug: "si-assistant",
        callSid: "CA" + "a".repeat(32),
        outcome: "agent_ended",
        startedAtMs: 0,
        endedAtMs: 12_000,
      },
      extras,
      {
        async report(payload) {
          posted.push({ body: JSON.stringify(payload) });
          return { ok: true, status: 200 };
        },
      },
    );
    expect(posted[0].body).toContain("tid-9");
    expect(posted[0].body).toContain(TICKET);
    expect(posted[0].body).toContain("appr-1");
  });

  it("aligns the drizzle jti constraint name with the migration", () => {
    const schema = readFileSync(join(__dirname, "../../shared/schema.ts"), "utf8");
    const migration = readFileSync(join(__dirname, "../../migrations/add_plugin_api.sql"), "utf8");
    expect(schema).toContain('unique("api_tokens_jti_key")');
    expect(schema).not.toMatch(/jti: varchar\("jti".*\)\.notNull\(\)\.unique\(\)/);
    expect(schema).not.toContain("idx_api_tokens_jti");
    expect(migration).toContain("CONSTRAINT api_tokens_jti_key UNIQUE (jti)");
    expect(migration).not.toContain("idx_api_tokens_jti");
    expect(migration).toContain("contact_approvals_channel_check");
    expect(migration).toContain("contact_approvals_status_check");
    expect(migration).toContain("'sending'");
    expect(schema).toContain("'sending'");
    expect(migration).toContain("'unknown'");
    expect(schema).toContain("'unknown'");
    expect(migration).toContain("plugin_message_outbox");
    expect(schema).toContain('pgTable("plugin_message_outbox"');
    expect(schema).toContain('uniqueIndex("plugin_message_outbox_idempotency_key")');
    expect(schema).not.toContain('unique("plugin_message_outbox_idempotency_key")');
  });

  it("claims a confirm token into sending and will not resend a stale claim", async () => {
    const store = new MemoryPluginStore();
    const token = generateConfirmToken();
    const now = new Date("2026-10-22T18:00:00Z");
    await store.insertApproval({
      id: "appr-stale",
      channel: "sms",
      status: "approved",
      tokenJti: "preparer",
      ticketId: "tid-stale",
      ticketNumber: TICKET,
      payload: { phone: PHONE, body: "Hi" },
      payloadHash: hashPayload({ phone: PHONE, body: "Hi" }),
      confirmTokenHash: token.hash,
      confirmExpiresAt: new Date(now.getTime() + 60_000),
      confirmUsedAt: null,
      approvedBy: "staff",
      approvedAt: now,
      rejectedBy: null,
      rejectedAt: null,
      cancelledAt: null,
      committedAt: null,
      result: null,
      createdAt: now,
      updatedAt: now,
    });
    const claimed = await store.claimConfirmToken(token.hash, now);
    expect(claimed?.status).toBe("sending");
    expect(claimed?.confirmUsedAt).toEqual(now);
    expect(await store.claimConfirmToken(token.hash, now)).toBeNull();

    const stillFresh = await reapStaleSending(store, new Date(now.getTime() + STALE_SENDING_MS - 1));
    expect(stillFresh).toEqual([]);
    expect((await store.getApproval("appr-stale"))?.status).toBe("sending");

    const sms: Array<{ to: string; body: string }> = [];
    const swept = await reapStaleSending(store, new Date(now.getTime() + STALE_SENDING_MS + 1));
    expect(swept).toHaveLength(1);
    expect(swept[0].status).toBe("unknown");
    expect(swept[0].result).toEqual({ reason: "stale_send" });
    expect((await store.getApproval("appr-stale"))?.status).toBe("unknown");
    expect(sms).toEqual([]);
    expect(await markCommitted(store, "appr-stale", { queued: true }, now)).toBeNull();
    expect(await markFailed(store, "appr-stale", { reason: "send_failed" }, now)).toBeNull();
    const audit = await store.listAudit();
    const row = audit.find((e) => e.tool === "reap_stale_sending");
    expect(row).toMatchObject({ approvalId: "appr-stale", ticketId: "tid-stale", outcome: "unknown" });
    expect(JSON.stringify(row)).not.toContain("5555550111");
    expect(JSON.stringify(row)).not.toContain("Hi");
  });

  it("the SQL stale sweep only marks unknown", async () => {
    const seen: string[] = [];
    const store = createSqlPluginStore(async (text) => {
      seen.push(text);
      return [];
    });
    await store.reapStaleSending(new Date("2026-10-22T18:10:00Z"), new Date("2026-10-22T18:00:00Z"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/status = 'unknown'/);
    expect(seen[0]).toMatch(/stale_send/);
    expect(seen[0]).toMatch(/status = 'sending'/);
    expect(seen[0]).not.toMatch(/executeApproved|sendApproved|enqueue|sendMail/);
  });

  it("the SQL markOutbox persists the attempt count", async () => {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    const store = createSqlPluginStore(async (text, params) => {
      seen.push({ text, params: params ?? [] });
      return [];
    });
    await store.markOutbox(
      "obx-1",
      { status: "sending", attempts: 1, updatedAt: new Date("2026-10-22T18:00:00Z") },
      "pending",
    );
    expect(seen[0].text).toMatch(/attempts = COALESCE\(\$7, attempts\)/);
    expect(seen[0].params[6]).toBe(1);
  });

  it("the migration upgrades existing tables with ALTER TABLE ADD COLUMN IF NOT EXISTS", () => {
    const migration = readFileSync(join(__dirname, "../../migrations/add_plugin_api.sql"), "utf8");
    expect(migration).toMatch(/ALTER TABLE contact_approvals ADD COLUMN IF NOT EXISTS phone_key/);
    expect(migration).toMatch(/ALTER TABLE plugin_message_outbox ADD COLUMN IF NOT EXISTS idempotency_key/);
    expect(migration).toMatch(/ALTER TABLE plugin_message_outbox ADD COLUMN IF NOT EXISTS suggestions/);
    expect(migration).toMatch(/DROP CONSTRAINT IF EXISTS contact_approvals_status_check/);
    expect(migration).toMatch(/'unknown'/);
    expect(migration).toContain("plugin_message_outbox_idempotency_key");
  });
});
