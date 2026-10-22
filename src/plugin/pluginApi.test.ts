/**
 * Plugin API: approval gate, calling window, DNC, token expiry, no PHI
 * in audit or ticket-resolved logs. In-memory store only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import twilio from "twilio";
import { MemoryPluginStore } from "./store";
import { mountPluginApi } from "./routes";
import { createGraphMail, createMemoryGraphMail, type GraphMail } from "./email";
import { evaluateAndEnqueueCall, reportCallNotPlaced, siAssistantMayDial } from "./callEnqueue";
import { bindPluginStore } from "./bindings";
import { siAssistantPolicy } from "../agents/siAssistantAgent";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";
import { ChannelDoNotContact } from "../runtime/outbound/channelDnc";
import { auditContainsPhi, ticketResolvedLogFields } from "./phi";
import { ticketResolvedAuthorized } from "./ticketResolved";
import { CONFIRM_TTL_MS, generateConfirmToken, hashPayload } from "./tokens";
import { HELP_REPLY, START_REPLY, STOP_REPLY, classifyInboundSms, handleInboundSms, inboundSmsPreview, sendApprovedSms } from "./sms";
import { SI_ASSISTANT_EMAIL_DEFAULT } from "./siAssistantConstants";
import { mintScopesCompatible } from "./scopes";
import { createSqlPluginStore } from "./sqlStore";
import { extrasFromContactData, reportSiAssistantCall, type CallbackReporter } from "./callbackReport";
import { markCommitted, markFailed, reapStaleSending } from "./approvals";
import { STALE_SENDING_MS } from "./store";
import type { SmsSender } from "./sms";

const PHONE = "+15555550111";
const TICKET = "VA-61001";
const CALL_DOB = "March 17, 1950";

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
    callbackReporter?: CallbackReporter | null;
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
    callbackReporter: extras.callbackReporter,
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

/** The switches the dialler reads. A call commit is refused without them
 * (v115), so every test boots with dialing on unless it says otherwise. */
const DIALING_ON = {
  RUNTIME_OUTBOUND_DIALING: "1",
  OUTBOUND_CAMPAIGN_SI_ASSISTANT: "1",
  SI_ASSISTANT_NUMBER: "+19092553213",
} as const;

async function boot(env: Record<string, string | undefined>, extras?: Parameters<typeof listen>[1]) {
  const ctx = await listen({ ...DIALING_ON, ...env }, extras);
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
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, firstName: "Testa", dateOfBirth: CALL_DOB }),
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
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, firstName: "Testa", dateOfBirth: CALL_DOB }),
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

  it("enqueue writes the ticket patient's name and date of birth onto the contact", async () => {
    const now = () => new Date("2026-10-22T18:00:00Z");
    const { base, store, outbound } = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { now });
    const bot = store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = store.mint(["contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: PHONE,
        ticketNumber: TICKET,
        ticketId: "tid-9",
        firstName: "Testa",
        lastName: "Patient",
        dateOfBirth: "March 17, 1950",
      }),
    });
    expect(prep.status).toBe(201);
    const pending = (await prep.json()) as { approval: { id: string } };
    const row = await store.getApproval(pending.approval.id);
    expect(row?.payload).toMatchObject({ firstName: "Testa", lastName: "Patient", dateOfBirth: "March 17, 1950" });
    const approved = await staffApprove(base, staff, store, pending.approval.id);
    const token = (await approved.json()) as { confirmToken: string };
    const committed = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(committed.status).toBe(200);
    const contact = [...outbound.contacts.values()][0];
    expect(contact.firstName).toBe("Testa");
    expect(contact.lastName).toBe("Patient");
    expect(contact.customData.date_of_birth).toBe("1950-03-17");
    const audit = await store.listAudit();
    expect(JSON.stringify(audit)).not.toContain("1950");
    expect(JSON.stringify(audit)).not.toContain("March 17");
    expect(JSON.stringify(audit)).not.toContain("Patient");
  });

  it("prepare_call returns 400 when the date of birth is missing or unparseable", async () => {
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" });
    const bot = store.mint(["contacts:prepare"]);
    const missing = await fetch(`${base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, firstName: "Testa" }),
    });
    expect(missing.status).toBe(400);
    const missingBody = (await missing.json()) as { error: string };
    expect(missingBody.error).toMatch(/date of birth is required/i);

    const unparseable = await fetch(`${base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: PHONE,
        ticketNumber: TICKET,
        dateOfBirth: "1960-03-05T00:00:00.000Z",
      }),
    });
    expect(unparseable.status).toBe(400);
    const unparseableBody = (await unparseable.json()) as { error: string };
    expect(unparseableBody.error).toMatch(/unparseable/i);
  });

  it("prepare_call returns 400 when dateOfBirth and date_of_birth disagree", async () => {
    const { base, store } = await boot({ PLUGIN_WRITES_ENABLED: "true" });
    const minted = store.mint(["contacts:prepare"]);
    const res = await fetch(`${base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${minted.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: PHONE,
        ticketNumber: TICKET,
        dateOfBirth: "March 17, 1950",
        date_of_birth: "1951-03-17",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/dateOfBirth and date_of_birth disagree/i);
  });

  it("prepare_call accepts ticketing birthMonth, birthDay and birthYear", async () => {
    const now = () => new Date("2026-10-22T18:00:00Z");
    const { base, store, outbound } = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { now });
    const bot = store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = store.mint(["contacts:approve"]);
    const prep = await fetch(`${base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: PHONE,
        ticketNumber: TICKET,
        firstName: "Testa",
        lastName: "Patient",
        birthMonth: 3,
        birthDay: 17,
        birthYear: 1950,
      }),
    });
    expect(prep.status).toBe(201);
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await staffApprove(base, staff, store, pending.approval.id);
    const token = (await approved.json()) as { confirmToken: string };
    const committed = await fetch(`${base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(committed.status).toBe(200);
    const contact = [...outbound.contacts.values()][0];
    expect(contact.customData.date_of_birth).toBe("1950-03-17");
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
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, firstName: "Testa", dateOfBirth: CALL_DOB }),
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
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, dateOfBirth: CALL_DOB }),
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

  it("voice opt-out then SMS START keeps the call blocked", async () => {
    const channels = new ChannelDoNotContact();
    const outbound = new FakeOutboundStore();
    outbound.channelDnc = channels;
    const store = new MemoryPluginStore();
    store.channelDnc = channels;
    const sender = { async send() { return { sid: "SM-start" }; } };
    await outbound.stampDoNotContact(PHONE, "opt_out_of_calls");
    await handleInboundSms(store, sender, { from: PHONE, body: "START" }, {});
    // The voice row survives START and blocks texts as well as calls.
    expect(await store.isSmsOptedOut("5555550111")).toBe(true);
    expect(await outbound.isDoNotContact(PHONE)).toBe(true);
    const result = await evaluateAndEnqueueCall(
      outbound,
      { approvalId: "appr-1", phone: PHONE, ticketNumber: TICKET },
      new Date("2026-10-22T18:00:00Z"),
    );
    expect(result).toEqual({ ok: false, reason: "do_not_contact" });
    expect(outbound.upserts).toEqual([]);
  });

  it("START to a number a voice row still blocks sends no reply and texts stay blocked", async () => {
    const channels = new ChannelDoNotContact();
    const outbound = new FakeOutboundStore();
    outbound.channelDnc = channels;
    const store = new MemoryPluginStore();
    store.channelDnc = channels;
    const sent: string[] = [];
    const sender = { async send(o: { body: string }) { sent.push(o.body); return { sid: "SM-x" }; } };
    await outbound.stampDoNotContact(PHONE, "opt_out_of_calls");
    const out = await handleInboundSms(store, sender, { from: PHONE, body: "START" }, {});
    expect(out).toEqual({ command: "start", replied: false });
    expect(sent).toEqual([]);
    expect(await store.isSmsOptedOut("5555550111")).toBe(true);
    const sms = await sendApprovedSms(store, sender, { phone: PHONE, body: "hello" }, {});
    expect(sms).toMatchObject({ ok: false, reason: "sms_opted_out" });
    expect(sent).toEqual([]);
  });

  it("START with only an sms_stop row still replies START_REPLY", async () => {
    const store = new MemoryPluginStore();
    const sent: string[] = [];
    const sender = { async send(o: { body: string }) { sent.push(o.body); return { sid: "SM-y" }; } };
    await handleInboundSms(store, sender, { from: PHONE, body: "STOP" }, {});
    sent.length = 0;
    const out = await handleInboundSms(store, sender, { from: PHONE, body: "START" }, {});
    expect(out).toEqual({ command: "start", replied: true });
    expect(sent).toEqual([START_REPLY]);
  });

  it("the HELP reply names the program, a contact number and how to opt out", () => {
    expect(HELP_REPLY).toContain("Azul Vision SI Assistant");
    expect(HELP_REPLY).toMatch(/call \(909\) 255-3213/);
    expect(HELP_REPLY).toContain("Reply STOP to opt out");
  });

  it("HELP from a number blocked by a voice do_not_contact row still gets the HELP reply (CTIA)", async () => {
    const channels = new ChannelDoNotContact();
    const outbound = new FakeOutboundStore();
    outbound.channelDnc = channels;
    const store = new MemoryPluginStore();
    store.channelDnc = channels;
    const sent: string[] = [];
    const sender = { async send(o: { body: string }) { sent.push(o.body); return { sid: "SM-h" }; } };
    await outbound.stampDoNotContact(PHONE, "opt_out_of_calls");
    expect(await store.isSmsOptedOut("5555550111")).toBe(true);
    expect(await handleInboundSms(store, sender, { from: PHONE, body: "HELP" }, {})).toEqual({
      command: "help",
      replied: true,
    });
    expect(sent).toEqual([HELP_REPLY]);
    // HELP changes no opt-out state.
    expect(await store.isSmsOptedOut("5555550111")).toBe(true);
  });

  it("HELP from a number blocked by an SMS STOP still gets the HELP reply (CTIA)", async () => {
    const store = new MemoryPluginStore();
    const sent: string[] = [];
    const sender = { async send(o: { body: string }) { sent.push(o.body); return { sid: "SM-h" }; } };
    await handleInboundSms(store, sender, { from: PHONE, body: "STOP" }, {});
    sent.length = 0;
    expect(await store.isSmsOptedOut("5555550111")).toBe(true);
    expect(await handleInboundSms(store, sender, { from: PHONE, body: "HELP" }, {})).toEqual({
      command: "help",
      replied: true,
    });
    expect(sent).toEqual([HELP_REPLY]);
    expect(await store.isSmsOptedOut("5555550111")).toBe(true);
  });

  it("a voice opt-out blocks an approved SMS", async () => {
    const channels = new ChannelDoNotContact();
    const outbound = new FakeOutboundStore();
    outbound.channelDnc = channels;
    const store = new MemoryPluginStore();
    store.channelDnc = channels;
    const sent: string[] = [];
    const sender = { async send(o: { body: string }) { sent.push(o.body); return { sid: "SM-v" }; } };
    await outbound.stampDoNotContact(PHONE, "opt_out_of_calls");
    const out = await sendApprovedSms(store, sender, { phone: PHONE, body: "Your request is in." }, {});
    expect(out).toMatchObject({ ok: false, reason: "sms_opted_out", mayHaveSent: false });
    expect(sent).toEqual([]);
  });

  it("an SMS STOP blocks calls", async () => {
    const channels = new ChannelDoNotContact();
    const outbound = new FakeOutboundStore();
    outbound.channelDnc = channels;
    const store = new MemoryPluginStore();
    store.channelDnc = channels;
    const sender = { async send() { return { sid: "SM-stop" }; } };
    await handleInboundSms(store, sender, { from: PHONE, body: "STOP" }, {});
    expect(await outbound.isDoNotContact(PHONE)).toBe(true);
    const result = await evaluateAndEnqueueCall(
      outbound,
      { approvalId: "appr-1", phone: PHONE, ticketNumber: TICKET },
      new Date("2026-10-22T18:00:00Z"),
    );
    expect(result).toEqual({ ok: false, reason: "do_not_contact" });
    expect(outbound.upserts).toEqual([]);
    // START with no voice row unblocks both channels.
    await handleInboundSms(store, sender, { from: PHONE, body: "START" }, {});
    expect(await store.isSmsOptedOut("5555550111")).toBe(false);
    expect(await outbound.isDoNotContact(PHONE)).toBe(false);
  });

  it("SMS STOP then voice opt-out then SMS START keeps both channels blocked", async () => {
    const channels = new ChannelDoNotContact();
    const outbound = new FakeOutboundStore();
    outbound.channelDnc = channels;
    const store = new MemoryPluginStore();
    store.channelDnc = channels;
    const sender = { async send() { return { sid: "SM-rev" }; } };
    await handleInboundSms(store, sender, { from: PHONE, body: "STOP" }, {});
    expect(await store.isSmsOptedOut("5555550111")).toBe(true);
    expect(await outbound.isDoNotContact(PHONE)).toBe(true);
    await outbound.stampDoNotContact(PHONE, "opt_out_of_calls");
    expect(await outbound.isDoNotContact(PHONE)).toBe(true);
    await handleInboundSms(store, sender, { from: PHONE, body: "START" }, {});
    // START deleted only the sms_stop row; the voice row still blocks both.
    expect(channels.sms.has("5555550111")).toBe(false);
    expect(channels.voice.has("5555550111")).toBe(true);
    expect(await store.isSmsOptedOut("5555550111")).toBe(true);
    expect(await outbound.isDoNotContact(PHONE)).toBe(true);
    const sms = await sendApprovedSms(store, sender, { phone: PHONE, body: "hello" }, {});
    expect(sms).toMatchObject({ ok: false, reason: "sms_opted_out" });
    const result = await evaluateAndEnqueueCall(
      outbound,
      { approvalId: "appr-1", phone: PHONE, ticketNumber: TICKET },
      new Date("2026-10-22T18:00:00Z"),
    );
    expect(result).toEqual({ ok: false, reason: "do_not_contact" });
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
      if (String(url).includes("/mailFolders/inbox/messages")) {
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
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

    const listed = await mail!.listReplies({ top: 5 });
    expect(listed).toEqual([]);
    expect(calls[2].url).toBe(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SI_ASSISTANT_EMAIL_DEFAULT)}/mailFolders/inbox/messages?$top=5&$select=id,receivedDateTime,conversationId,from,subject,isDraft&$orderby=receivedDateTime desc`,
    );
    expect(calls[2].url).not.toMatch(/\/users\/[^/]+\/messages\?/);
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

  it("posts an unmatched inbound text through the outbox, not as an empty item", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const { base, store, server } = await boot(
      { PLUGIN_WRITES_ENABLED: "true", TWILIO_AUTH_TOKEN: TWILIO_AUTH },
      {
        callbackReporter: {
          async report(payload) {
            posted.push(payload as unknown as Record<string, unknown>);
            return { ok: true, status: 200 };
          },
        },
      },
    );
    const port = (server.address() as { port: number }).port;
    const path = "/api/plugin/v1/webhooks/twilio-sms";
    const body = { From: PHONE, Body: "Can someone call me back about my glasses?" };
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
    const deadline = Date.now() + 500;
    while (store.outbox.size === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const postedUntil = Date.now() + 500;
    while (!posted.some((p) => p.event === "message") && Date.now() < postedUntil) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect([...store.outbox.values()]).toHaveLength(1);
    expect(posted.some((p) => p.event === "inbound_sms")).toBe(false);
    expect(posted.some((p) => p.event === "message" && p.message === "Can someone call me back about my glasses?")).toBe(true);
    // The sender rides on the webhook payload so staff can reply to it.
    expect(posted.find((p) => p.event === "message")?.from).toBe(PHONE);
  });

  it("dedupes a Twilio retry of one inbound text by MessageSid, and never logs the sender or body", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      }),
    );
    try {
      const { base, store, server } = await boot(
        { PLUGIN_WRITES_ENABLED: "true", TWILIO_AUTH_TOKEN: TWILIO_AUTH },
        {
          callbackReporter: {
            async report(payload) {
              posted.push(payload as unknown as Record<string, unknown>);
              return { ok: true, status: 200 };
            },
          },
        },
      );
      const port = (server.address() as { port: number }).port;
      const path = "/api/plugin/v1/webhooks/twilio-sms";
      const messageSid = "SM" + "3".repeat(32);
      const body = { From: PHONE, Body: "Is my order ready?", MessageSid: messageSid };
      const signed = signedSms(path, body, `127.0.0.1:${port}`);
      for (let i = 0; i < 2; i += 1) {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Twilio-Signature": signed.signature,
          },
          body: new URLSearchParams(body).toString(),
        });
        expect(res.status).toBe(200);
      }
      const until = Date.now() + 500;
      while (!posted.some((p) => p.event === "message") && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 30));
      const rows = [...store.outbox.values()];
      expect(rows).toHaveLength(1);
      expect(rows[0].idempotencyKey).toBe(`sms:${messageSid}`);
      expect(rows[0].messageSid).toBe(messageSid);
      expect(rows[0].fromPhone).toBe(PHONE);
      const messages = posted.filter((p) => p.event === "message");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ from: PHONE, messageSid, idempotencyKey: `sms:${messageSid}` });
      const all = logged.join("\n");
      expect(all).not.toContain("5555550111");
      expect(all).not.toContain("Is my order ready?");
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("skips an empty inbound text so Support Center does not get a blank item", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const { base, store, server } = await boot(
      { PLUGIN_WRITES_ENABLED: "true", TWILIO_AUTH_TOKEN: TWILIO_AUTH },
      {
        callbackReporter: {
          async report(payload) {
            posted.push(payload as unknown as Record<string, unknown>);
            return { ok: true, status: 200 };
          },
        },
      },
    );
    const port = (server.address() as { port: number }).port;
    const path = "/api/plugin/v1/webhooks/twilio-sms";
    const body = { From: PHONE, Body: "   " };
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
    await new Promise((r) => setTimeout(r, 20));
    expect(store.outbox.size).toBe(0);
    expect(posted).toEqual([]);
    expect(inboundSmsPreview("")).toBeNull();
    expect(inboundSmsPreview("   \n")).toBeNull();
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
    expect(await committed.json()).toMatchObject({ outcome: "unknown" });
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

  it("caps a second approval on a number another approval rang today, as the dialler would (v115)", async () => {
    // The dialler's caps are per PHONE (priorAttempts reads every attempt in
    // the campaign on the number). A commit that read only its own row would
    // answer "queued" for a call the dialler then holds until its place-by
    // deadline lapses.
    let clock = new Date("2026-10-22T16:30:00Z"); // 9:30 Pacific
    const outbound = new FakeOutboundStore(() => clock);
    const campaignId = await outbound.ensureCampaign();
    await outbound.upsertSourceContacts(campaignId!, [
      { externalRef: "plugin:other-approval", phone: PHONE, firstName: "Other", lastName: null, data: {} },
    ]);
    const other = (await outbound.sourceRows(campaignId!))[0];
    const attemptId = await outbound.startAttempt(other.id, campaignId!, 1);
    await outbound.finishAttempt(attemptId, { status: "no_answer" });
    clock = new Date("2026-10-22T18:00:00Z");
    const result = await evaluateAndEnqueueCall(outbound, { approvalId: "new-approval", phone: PHONE, ticketNumber: TICKET }, clock);
    expect(result).toEqual({ ok: false, reason: "daily_cap" });
    expect(outbound.upserts).toEqual([1]);
  });

  it("lets a second approval through once the earlier dial is days old: per-phone caps, not a ban", async () => {
    let clock = new Date("2026-10-19T17:00:00Z");
    const outbound = new FakeOutboundStore(() => clock);
    const campaignId = await outbound.ensureCampaign();
    await outbound.upsertSourceContacts(campaignId!, [
      { externalRef: "plugin:other-approval", phone: PHONE, firstName: "Other", lastName: null, data: {} },
    ]);
    const other = (await outbound.sourceRows(campaignId!))[0];
    const attemptId = await outbound.startAttempt(other.id, campaignId!, 1);
    await outbound.finishAttempt(attemptId, { status: "no_answer" });
    clock = new Date("2026-10-22T18:00:00Z");
    const result = await evaluateAndEnqueueCall(outbound, { approvalId: "new-approval", phone: PHONE, ticketNumber: TICKET }, clock);
    expect(result).toMatchObject({ ok: true, queued: true });
  });

  it("stops at the total cap across every approval on the number", async () => {
    let clock = new Date("2026-09-01T17:00:00Z");
    const outbound = new FakeOutboundStore(() => clock);
    const campaignId = await outbound.ensureCampaign();
    for (const [i, day] of ["2026-09-01", "2026-09-10", "2026-09-20"].entries()) {
      clock = new Date(`${day}T17:00:00Z`);
      await outbound.upsertSourceContacts(campaignId!, [
        { externalRef: `plugin:old-${i}`, phone: PHONE, firstName: "Other", lastName: null, data: {} },
      ]);
      const row = (await outbound.sourceRows(campaignId!)).find((r) => r.externalRef === `plugin:old-${i}`)!;
      const attemptId = await outbound.startAttempt(row.id, campaignId!, 1);
      await outbound.finishAttempt(attemptId, { status: "no_answer" });
    }
    clock = new Date("2026-10-22T18:00:00Z");
    const result = await evaluateAndEnqueueCall(outbound, { approvalId: "new-approval", phone: PHONE, ticketNumber: TICKET }, clock);
    expect(result).toEqual({ ok: false, reason: "total_cap" });
  });

  it("does not count a dial Twilio refused on another approval's row", async () => {
    let clock = new Date("2026-10-22T16:30:00Z");
    const outbound = new FakeOutboundStore(() => clock);
    const campaignId = await outbound.ensureCampaign();
    await outbound.upsertSourceContacts(campaignId!, [
      { externalRef: "plugin:other-approval", phone: PHONE, firstName: "Other", lastName: null, data: {} },
    ]);
    const other = (await outbound.sourceRows(campaignId!))[0];
    const refused = await outbound.startAttempt(other.id, campaignId!, 1);
    await outbound.finishAttempt(refused, { status: "not_placed" });
    clock = new Date("2026-10-22T18:00:00Z");
    const result = await evaluateAndEnqueueCall(outbound, { approvalId: "new-approval", phone: PHONE, ticketNumber: TICKET }, clock);
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
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, dateOfBirth: CALL_DOB }),
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
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, dateOfBirth: CALL_DOB }),
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

  it("the SQL SMS opt-out writes per channel but reads any row, so START cannot erase a voice row", async () => {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    const store = createSqlPluginStore(async (text, params) => {
      seen.push({ text, params: params ?? [] });
      return [];
    });
    await store.isSmsOptedOut("5555550111");
    await store.setSmsOptOut("5555550111", true);
    await store.setSmsOptOut("5555550111", false);
    // The read has no source filter: a voice row blocks texts too.
    expect(seen[0].text).toMatch(/FROM do_not_contact WHERE phone_key = \$1/);
    expect(seen[0].text).not.toMatch(/source/);
    expect(seen[0].params).toEqual(["5555550111"]);
    // The conflict target is the Hub's unique index (phone_key, source). A
    // target the live table has no unique index for is a 42P10 on every STOP.
    expect(seen[1].text).toMatch(/ON CONFLICT \(phone_key, source\) DO NOTHING/);
    expect(seen[1].text).not.toMatch(/ON CONFLICT \(phone_key\)/);
    expect(seen[1].params[1]).toBe("sms_stop");
    expect(seen[2].text).toMatch(/DELETE FROM do_not_contact/);
    expect(seen[2].text).toMatch(/source = \$2/);
    expect(seen[2].params[1]).toBe("sms_stop");
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

  it("the migration enables RLS on every plugin table, without FORCE and without policies", () => {
    const migration = readFileSync(join(__dirname, "../../migrations/add_plugin_api.sql"), "utf8");
    for (const t of ["api_tokens", "contact_approvals", "plugin_audit_log", "plugin_message_outbox"]) {
      expect(migration).toMatch(new RegExp(`^ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`, "m"));
    }
    const live = migration
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(live).not.toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(live).not.toMatch(/CREATE POLICY/i);
    // do_not_contact belongs to the outbound store's ensureSchema, not here.
    expect(live).not.toMatch(/do_not_contact/);
  });

  it("the per-channel key is a migration's job, and the runtime never alters the table (v115)", () => {
    // The Hub took (phone_key, source) from this migration on 2026-10-22.
    // v114 also dropped the old primary key on first use in ensureSchema, a
    // schema change on a live table; the runtime now only creates.
    const migration = readFileSync(join(__dirname, "../../migrations/add_do_not_contact_per_channel.sql"), "utf8");
    expect(migration).toMatch(/DROP CONSTRAINT IF EXISTS do_not_contact_pkey/);
    expect(migration).toContain("do_not_contact_phone_source_uidx");
    const store = readFileSync(join(__dirname, "../runtime/outbound/store.ts"), "utf8");
    expect(store).not.toMatch(/DROP CONSTRAINT[^;`]*do_not_contact_pkey/);
    expect(store).toContain("do_not_contact_phone_source_uidx");
    const schema = readFileSync(join(__dirname, "../../shared/schema.ts"), "utf8");
    expect(schema).toMatch(/uniqueIndex\("do_not_contact_phone_source_uidx"\)\.on\(table\.phoneKey, table\.source\)/);
    expect(schema).not.toMatch(/pgTable\("do_not_contact", \{\s*phoneKey: varchar\("phone_key", \{ length: 10 \}\)\.primaryKey\(\)/);
  });
});

describe("a call commit needs a dialler that will place it (v115)", () => {
  const noon = () => new Date("2026-10-22T18:00:00Z");

  async function approveCall(env: Record<string, string | undefined>) {
    const ctx = await boot({ PLUGIN_WRITES_ENABLED: "true", ...env }, { now: noon });
    const bot = ctx.store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = ctx.store.mint(["contacts:approve"]);
    const prep = await fetch(`${ctx.base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, firstName: "Testa", dateOfBirth: CALL_DOB }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await staffApprove(ctx.base, staff, ctx.store, pending.approval.id);
    const token = (await approved.json()) as { confirmToken: string };
    const committed = await fetch(`${ctx.base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    return { ...ctx, committed, approvalId: pending.approval.id };
  }

  for (const [label, env, reason] of [
    ["the fleet switch is off", { RUNTIME_OUTBOUND_DIALING: "0" }, "outbound_dialing_off"],
    ["the campaign switch is off", { OUTBOUND_CAMPAIGN_SI_ASSISTANT: undefined }, "campaign_off"],
    ["no caller ID is set", { SI_ASSISTANT_NUMBER: " " }, "no_caller_id"],
  ] as const) {
    it(`refuses with 503, queues nothing and fails the approval when ${label}`, async () => {
      const { committed, outbound, store, approvalId } = await approveCall(env);
      expect(committed.status).toBe(503);
      expect(((await committed.json()) as { error: string }).error).toContain(reason);
      expect(outbound.contacts.size).toBe(0);
      expect(outbound.upserts).toEqual([]);
      expect((await store.getApproval(approvalId))?.status).toBe("failed");
    });
  }

  it("stamps the queued contact with a place-by deadline two hours out", async () => {
    const { committed, outbound } = await approveCall({});
    expect(committed.status).toBe(200);
    const contact = [...outbound.contacts.values()][0];
    expect(contact.customData.place_by).toBe(new Date(noon().getTime() + 2 * 60 * 60 * 1000).toISOString());
  });

  it("says the call was not sent when dialing is off (outcome not_sent)", async () => {
    const { committed } = await approveCall({ RUNTIME_OUTBOUND_DIALING: "0" });
    expect(committed.status).toBe(503);
    expect(await committed.json()).toMatchObject({ outcome: "not_sent" });
  });

  it("says the call was not sent when a cap refuses it (outcome not_sent)", async () => {
    const outbound = new FakeOutboundStore(() => new Date("2026-10-22T16:30:00Z"));
    const campaignId = await outbound.ensureCampaign();
    await outbound.upsertSourceContacts(campaignId!, [
      { externalRef: "plugin:earlier", phone: PHONE, firstName: "Testa", lastName: null, data: {} },
    ]);
    const earlier = (await outbound.sourceRows(campaignId!))[0];
    await outbound.finishAttempt(await outbound.startAttempt(earlier.id, campaignId!, 1), { status: "no_answer" });
    const ctx = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { now: noon, outbound });
    const bot = ctx.store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = ctx.store.mint(["contacts:approve"]);
    const prep = await fetch(`${ctx.base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, firstName: "Testa", dateOfBirth: CALL_DOB }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await staffApprove(ctx.base, staff, ctx.store, pending.approval.id);
    const token = (await approved.json()) as { confirmToken: string };
    const committed = await fetch(`${ctx.base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(committed.status).toBe(422);
    expect(await committed.json()).toEqual({ error: "Call was not placed: daily_cap", outcome: "not_sent" });
    expect((await ctx.store.getApproval(pending.approval.id))?.status).toBe("failed");
    expect(outbound.upserts).toEqual([1]);
  });

  it("says the outcome is unknown when queueing throws after the claim (outcome unknown)", async () => {
    const outbound = new FakeOutboundStore(() => noon());
    outbound.upsertSourceContacts = async () => { throw new Error("hub timeout"); };
    const ctx = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { now: noon, outbound });
    const bot = ctx.store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = ctx.store.mint(["contacts:approve"]);
    const prep = await fetch(`${ctx.base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, firstName: "Testa", dateOfBirth: CALL_DOB }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await staffApprove(ctx.base, staff, ctx.store, pending.approval.id);
    const token = (await approved.json()) as { confirmToken: string };
    const committed = await fetch(`${ctx.base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(committed.status).toBe(502);
    expect(await committed.json()).toEqual({ error: "The send outcome is unknown", outcome: "unknown" });
    expect((await ctx.store.getApproval(pending.approval.id))?.status).toBe("unknown");
  });

  it("says nothing was sent when the approved payload no longer matches its lock (outcome not_sent)", async () => {
    const ctx = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { now: noon });
    const bot = ctx.store.mint(["contacts:prepare", "contacts:commit"]);
    const staff = ctx.store.mint(["contacts:approve"]);
    const prep = await fetch(`${ctx.base}/api/plugin/v1/prepare_call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, ticketNumber: TICKET, firstName: "Testa", dateOfBirth: CALL_DOB }),
    });
    const pending = (await prep.json()) as { approval: { id: string } };
    const approved = await staffApprove(ctx.base, staff, ctx.store, pending.approval.id);
    const token = (await approved.json()) as { confirmToken: string };
    const row = await ctx.store.getApproval(pending.approval.id);
    await ctx.store.updateApproval(pending.approval.id, { payload: { ...row!.payload, purpose: "changed after approval" } });
    const committed = await fetch(`${ctx.base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: token.confirmToken }),
    });
    expect(committed.status).toBe(409);
    expect(await committed.json()).toEqual({ error: "Approved payload no longer matches the locked hash", outcome: "not_sent" });
    expect(ctx.outbound.upserts).toEqual([]);
  });

  it("carries no outcome on a refusal before the confirm token is consumed", async () => {
    const ctx = await boot({ PLUGIN_WRITES_ENABLED: "true" }, { now: noon });
    const bot = ctx.store.mint(["contacts:commit"]);
    const committed = await fetch(`${ctx.base}/api/plugin/v1/commit_contact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmToken: "a".repeat(64) }),
    });
    expect(committed.status).toBe(404);
    expect(await committed.json()).not.toHaveProperty("outcome");
  });
});

describe("a call that missed its place-by deadline fails its approval (v115)", () => {
  const now = new Date("2026-10-22T21:00:00Z");

  async function committedApproval(store: MemoryPluginStore, id: string, status: "committed" | "failed" | "unknown" = "committed") {
    const token = generateConfirmToken();
    await store.insertApproval({
      id,
      channel: "call",
      status,
      tokenJti: "jti-bot",
      ticketId: "tid-7",
      ticketNumber: TICKET,
      payload: { phone: PHONE },
      payloadHash: hashPayload({ phone: PHONE }),
      confirmTokenHash: token.hash,
      confirmExpiresAt: now,
      confirmUsedAt: now,
      approvedBy: "staff",
      approvedAt: now,
      rejectedBy: null,
      rejectedAt: null,
      cancelledAt: null,
      committedAt: now,
      result: { queued: true, campaignId: "campaign-1" },
      createdAt: now,
      updatedAt: now,
    });
  }

  it("moves a committed approval to failed, keeps its result, and audits without PHI", async () => {
    const store = new MemoryPluginStore();
    await committedApproval(store, "appr-late");
    await reportCallNotPlaced({ id: "c1", customData: { approval_id: "appr-late", place_by: now.toISOString() } }, store, now);
    const row = await store.getApproval("appr-late");
    expect(row?.status).toBe("failed");
    expect(row?.result).toEqual({ queued: false, campaignId: "campaign-1", placed: false, reason: "place_by_passed" });
    const audit = (await store.listAudit()).filter((e) => e.tool === "call_not_placed");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ approvalId: "appr-late", ticketId: "tid-7", outcome: "failed", httpStatus: 410, method: "SWEEP" });
    expect(JSON.stringify(audit)).not.toContain("5555550111");
  });

  it("reports once: a second report changes nothing and writes no second audit row", async () => {
    const store = new MemoryPluginStore();
    await committedApproval(store, "appr-late");
    await reportCallNotPlaced({ id: "c1", customData: { approval_id: "appr-late" } }, store, now);
    await reportCallNotPlaced({ id: "c1", customData: { approval_id: "appr-late" } }, store, now);
    expect((await store.listAudit()).filter((e) => e.tool === "call_not_placed")).toHaveLength(1);
  });

  it.each(["failed", "unknown"] as const)("leaves a %s approval alone", async (status) => {
    const store = new MemoryPluginStore();
    await committedApproval(store, "appr-x", status);
    await reportCallNotPlaced({ id: "c1", customData: { approval_id: "appr-x" } }, store, now);
    expect((await store.getApproval("appr-x"))?.status).toBe(status);
    expect((await store.listAudit()).filter((e) => e.tool === "call_not_placed")).toHaveLength(0);
  });

  it("moves nothing when the approval left committed after it was read (the update is conditional)", async () => {
    const store = new MemoryPluginStore();
    await committedApproval(store, "appr-race", "unknown");
    const real = store.getApproval.bind(store);
    store.getApproval = async (id) => {
      const row = await real(id);
      return row ? { ...row, status: "committed" } : row;
    };
    await reportCallNotPlaced({ id: "c1", customData: { approval_id: "appr-race" } }, store, now);
    expect((await real("appr-race"))?.status).toBe("unknown");
    expect((await store.listAudit()).filter((e) => e.tool === "call_not_placed")).toHaveLength(0);
  });

  it("does nothing without an approval id or a store", async () => {
    const store = new MemoryPluginStore();
    await committedApproval(store, "appr-late");
    await reportCallNotPlaced({ id: "c1", customData: {} }, store, now);
    await reportCallNotPlaced({ id: "c1", customData: { approval_id: "appr-late" } }, null, now);
    expect((await store.getApproval("appr-late"))?.status).toBe("committed");
  });

  it("keeps the approval failed when its audit row cannot be written", async () => {
    const store = new MemoryPluginStore();
    await committedApproval(store, "appr-late");
    store.writeAudit = async () => { throw new Error("audit down"); };
    await expect(reportCallNotPlaced({ id: "c1", customData: { approval_id: "appr-late" } }, store, now)).resolves.toBeUndefined();
    expect((await store.getApproval("appr-late"))?.status).toBe("failed");
  });

  it("is the SI Assistant lane's place-by hook, reading the bound store", async () => {
    const store = new MemoryPluginStore();
    await committedApproval(store, "appr-lane");
    bindPluginStore(store);
    try {
      expect(siAssistantPolicy.onPlaceByPassed).toBeTypeOf("function");
      await siAssistantPolicy.onPlaceByPassed!({ id: "c1", customData: { approval_id: "appr-lane" } });
      expect((await store.getApproval("appr-lane"))?.status).toBe("failed");
    } finally {
      bindPluginStore(null);
    }
  });
});

describe("inbound SMS keywords and replies (v115)", () => {
  it("a plain Yes from a number that never opted out is a reply for My Messages, not START", async () => {
    const store = new MemoryPluginStore();
    const sent: string[] = [];
    const sender = { async send(o: { body: string }) { sent.push(o.body); return { sid: "SM-yes" }; } };
    const out = await handleInboundSms(store, sender, { from: PHONE, body: "Yes" }, {});
    expect(out).toEqual({ command: "other", replied: false });
    expect(sent).toEqual([]);
    expect(await store.isSmsOptedOut("5555550111")).toBe(false);
  });

  it("a plain Yes from a number that sent STOP opts it back in", async () => {
    const store = new MemoryPluginStore();
    const sent: string[] = [];
    const sender = { async send(o: { body: string }) { sent.push(o.body); return { sid: "SM-yes2" }; } };
    await handleInboundSms(store, sender, { from: PHONE, body: "STOP" }, {});
    sent.length = 0;
    const out = await handleInboundSms(store, sender, { from: PHONE, body: "yes." }, {});
    expect(out).toEqual({ command: "start", replied: true });
    expect(sent).toEqual([START_REPLY]);
    expect(await store.isSmsOptedOut("5555550111")).toBe(false);
  });

  it("a Yes whose opt-out state cannot be read is kept as a reply, never an opt-in", async () => {
    const store = new MemoryPluginStore();
    const real = store.isSmsOptedOut.bind(store);
    store.isSmsOptedOut = async () => { throw new Error("db down"); };
    const out = await handleInboundSms(store, null, { from: PHONE, body: "Yes" }, {});
    expect(out).toEqual({ command: "other", replied: false });
    store.isSmsOptedOut = real;
  });

  it.each(["STOP", "HELP"])(
    "a %s reply Twilio refuses (21610) does not undo or fail the keyword",
    async (keyword) => {
      const store = new MemoryPluginStore();
      const logged: string[] = [];
      const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
      const sender = {
        async send(): Promise<{ sid: string }> {
          const e = new Error("Attempt to send to unsubscribed recipient") as Error & { status: number; code: number };
          e.status = 400;
          e.code = 21610;
          throw e;
        },
      };
      const out = await handleInboundSms(store, sender, { from: PHONE, body: keyword }, {});
      err.mockRestore();
      expect(out).toEqual({ command: keyword.toLowerCase(), replied: false });
      if (keyword === "STOP") expect(await store.isSmsOptedOut("5555550111")).toBe(true);
      expect(logged.join(" ")).not.toContain("5555550111");
    },
  );

  it("STOP still confirms with STOP_REPLY when the reply goes through", async () => {
    const store = new MemoryPluginStore();
    const sent: string[] = [];
    const sender = { async send(o: { body: string }) { sent.push(o.body); return { sid: "SM-stop" }; } };
    expect(await handleInboundSms(store, sender, { from: PHONE, body: "STOP" }, {})).toEqual({ command: "stop", replied: true });
    expect(sent).toEqual([STOP_REPLY]);
  });

  it("the webhook answers 200 empty TwiML when the opt-out write fails, and logs no phone or body", async () => {
    const store = new MemoryPluginStore();
    store.setSmsOptOut = async () => { throw new Error("db down"); };
    const logged: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
    const { base, server } = await boot(
      { PLUGIN_WRITES_ENABLED: "true", TWILIO_AUTH_TOKEN: TWILIO_AUTH },
      { store, smsSender: { async send() { return { sid: "SM-z" }; } } },
    );
    const port = (server.address() as { port: number }).port;
    const path = "/api/plugin/v1/webhooks/twilio-sms";
    const body = { From: PHONE, Body: "STOP" };
    const signed = signedSms(path, body, `127.0.0.1:${port}`);
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signed.signature },
      body: new URLSearchParams(body).toString(),
    });
    err.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<Response></Response>");
    const all = logged.join(" ");
    expect(all).toContain("could not be handled");
    expect(all).not.toContain("5555550111");
  });
});
