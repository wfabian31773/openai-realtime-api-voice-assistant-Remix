import { afterEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { startStdio } from "../../connectors/voice-fleet-mcp/server.mjs";
import { MemoryPluginStore } from "./store";
import { mountVoiceFleetMcp, pluginAwareBodyParsers, VOICE_FLEET_MCP_PATH } from "./mcpRoute";

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

const rpc = (method: string, id: string | number = 1, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });
const tool = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", 1, { name: `voice_fleet_${name}`, arguments: args });

async function boot(setup?: (app: Express) => void, overrides: Record<string, string | undefined> = {}) {
  const app = express();
  // Same parser wiring as server/index.ts, including its original 100 KB default.
  app.use(pluginAwareBodyParsers());
  const store = new MemoryPluginStore();
  const token = store.mint();
  const env: Record<string, string | undefined> = { ...overrides };
  mountVoiceFleetMcp(app, { store, env });
  setup?.(app);
  app.post("/ordinary", (req, res) => res.json(req.body));
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  env.API_PORT ??= String(port);
  const base = `http://127.0.0.1:${port}`;
  const post = (body: unknown, bearer: string | null = token.plaintext, headers: Record<string, string> = {}) => fetch(base + VOICE_FLEET_MCP_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { app, base, store, token, env, post };
}

function data(reply: { result: { content: Array<{ text: string }> } }) {
  return JSON.parse(reply.result.content[0].text);
}

describe("hosted voice fleet MCP", () => {
  it("lists exactly the same 26 tools as the stdio process and reports v4", async () => {
    const { post } = await boot();
    const http = await (await post(rpc("tools/list"))).json();
    const input = new PassThrough();
    const output = new PassThrough();
    const shell = startStdio(input, output, {});
    const line = once(output, "data");
    input.end(JSON.stringify(rpc("tools/list")) + "\n");
    const [stdio] = await line;
    shell.close();
    expect(http).toEqual(JSON.parse(stdio.toString()));
    expect(http.result.tools).toHaveLength(26);
    const init = await (await post(rpc("initialize", 2, { protocolVersion: "2025-03-26" }))).json();
    expect(init.result.serverInfo.version).toBe("4.0.0");
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.capabilities).toEqual({ tools: {} });
  });

  it("authenticates before parsing invalid or oversized bodies", async () => {
    const { post, store, token } = await boot();
    const [prefix, jti] = token.plaintext.split(".");
    const wrongSecret = `${prefix}.${jti}.${"0".repeat(64)}`;
    const unknown = `si.${"0".repeat(32)}.${"0".repeat(64)}`;
    const revoked = store.mint();
    await store.revokeToken(revoked.jti, new Date());
    const expired = store.mint();
    (await store.findToken(expired.jti))!.expiresAt = new Date(0);
    for (const bearer of [null, "bad", wrongSecret, unknown, revoked.plaintext, expired.plaintext]) {
      const response = await post("{" + "x".repeat(1024 * 1024), bearer);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="voice-fleet-mcp"');
    }
    expect((await post(rpc("ping"))).status).toBe(200);
  });

  it("preserves batch order, omits notifications, and reports invalid members", async () => {
    const { post } = await boot();
    const response = await post([rpc("ping", "last-first"), { jsonrpc: "2.0", method: "notifications/initialized" }, null, rpc("missing", 3), rpc("tools/list", 0)]);
    expect(response.status).toBe(200);
    const replies = await response.json();
    expect(replies.map((reply: { id: unknown }) => reply.id)).toEqual(["last-first", null, 3, 0]);
    expect(replies[1].error.code).toBe(-32600);
    expect(replies[2].error.code).toBe(-32601);
    expect(replies[3].result.tools).toHaveLength(26);
    const empty = await post([]);
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.code).toBe(-32600);
  });

  it("returns an empty 202 for single and batch notifications without executing tools", async () => {
    const called = vi.fn();
    const { post } = await boot((app) => app.get("/api/plugin/v1/health", called));
    const notification = { jsonrpc: "2.0", method: "tools/call", params: { name: "voice_fleet_health" } };
    for (const payload of [notification, [notification, { jsonrpc: "2.0", method: "notifications/initialized" }]]) {
      const response = await post(payload);
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("");
    }
    expect(called).not.toHaveBeenCalled();
  });

  it("uses each caller's exact bearer on loopback and ignores forwarded hosts", async () => {
    const seen: Array<{ path: string; auth?: string }> = [];
    const { post, store, token } = await boot((app) => {
      app.get("/api/plugin/v1/health", (req, res) => {
        seen.push({ path: req.path, auth: req.headers.authorization });
        res.json({ ok: true });
      });
    });
    const other = store.mint();
    const hostileHeaders = { Host: "untrusted.invalid", "X-Forwarded-Host": "untrusted.invalid", "X-Forwarded-Proto": "https" };
    const replies = await Promise.all([post(tool("health"), token.plaintext, hostileHeaders), post(tool("health"), other.plaintext)]);
    for (const response of replies) expect(data(await response.json()).data.ok).toBe(true);
    expect(seen.map((request) => request.auth).sort()).toEqual([`Bearer ${token.plaintext}`, `Bearer ${other.plaintext}`].sort());
    expect(seen.every((request) => request.path === "/api/plugin/v1/health")).toBe(true);
  });

  it("honors the explicit internal URL and masks fleet output including echoed request data", async () => {
    const target = await boot((app) => app.post("/api/plugin/v1/prepare_sms", express.json(), (req, res) => {
      expect(req.body.phone).toBe("+19095550113");
      res.json({ ...req.body, email: "synthetic@example.test", note: "Mail synthetic@example.test or +1 (909) 555-0113", dateOfBirth: "synthetic-dob", confirmToken: "c".repeat(64) });
    }));
    const { post, token } = await boot(undefined, { VOICE_FLEET_MCP_INTERNAL_BASE_URL: target.base });
    const response = await post(tool("prepare_text", { phone: "+19095550113", name: "Synthetic Person", first_name: "Synthetic", body: "Synthetic private message" }));
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result.result.isError).toBe(false);
    expect(data(result).data).toEqual({ phone: "***-***-0113", name: "[redacted]", first_name: "[redacted]", body: "[redacted]", email: "[redacted]", note: "Mail [email] or ***-***-0113", dateOfBirth: "[redacted]", confirmToken: "[redacted]" });
    const text = JSON.stringify(result);
    for (const secret of [token.plaintext, "Synthetic Person", "synthetic@example.test", "Synthetic private message", "c".repeat(64)]) expect(text).not.toContain(secret);
  });

  it("returns JSON-RPC parse errors and enforces 1 MB after auth, beyond the global 100 KB parser", async () => {
    const { post, base, token } = await boot();
    for (const invalid of ["{", ""]) {
      const response = await post(invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    expect((await post(rpc("ping", 1, { padding: "x".repeat(200000) }))).status).toBe(200);
    const large = await post(rpc("ping", 1, { padding: "x".repeat(1024 * 1024) }));
    expect(large.status).toBe(413);
    // Express matches these aliases too: they must bypass the global parser as well.
    const alias = await fetch(base + "/API/PLUGIN/V1/MCP/", { method: "POST", headers: { Authorization: `Bearer ${token.plaintext}` }, body: "{" });
    expect(alias.status).toBe(400);
    expect((await alias.json()).error.code).toBe(-32700);
    const ordinary = await fetch(base + "/ordinary", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"ok":true}' });
    expect(await ordinary.json()).toEqual({ ok: true });
  });

  it.each(["GET", "DELETE", "HEAD", "PUT", "OPTIONS"])("refuses authenticated %s with Allow: POST", async (method) => {
    const { base, token } = await boot();
    const response = await fetch(base + VOICE_FLEET_MCP_PATH, { method, headers: { Authorization: `Bearer ${token.plaintext}` } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
