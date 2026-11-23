import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorRequestHandler, Express, NextFunction, Request, RequestHandler, Response } from "express";
import { Readable } from "node:stream";
import { MemoryPluginStore } from "./store";
import { mountVoiceFleetMcp, VOICE_FLEET_MCP_PATH } from "./mcpRoute";

afterEach(() => vi.restoreAllMocks());

const tool = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "voice_fleet_health" } };
const invalidRequest = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };

function boot(env: Record<string, string | undefined> = {}) {
  const store = new MemoryPluginStore();
  const token = store.mint();
  let handlers: Array<RequestHandler | ErrorRequestHandler> = [];
  // Exercise the mounted auth, origin check, raw parser and handler without TCP.
  const app = { all(path: string, ...middleware: typeof handlers) {
    expect(path).toBe(VOICE_FLEET_MCP_PATH);
    handlers = middleware;
  } } as unknown as Express;
  mountVoiceFleetMcp(app, { store, env });
  function post(body: unknown, headers: Record<string, string> = {}) {
    const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const requestHeaders: Record<string, string> = {
      authorization: `Bearer ${token.plaintext}`, "content-type": "application/json",
      "content-length": String(bytes.length),
      ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    };
    const req = Object.assign(Readable.from([bytes]), {
      method: "POST", headers: requestHeaders,
      get: (name: string) => requestHeaders[name.toLowerCase()],
    }) as unknown as Request;
    return new Promise<{ status: number; body?: unknown; headers: Headers }>((resolve, reject) => {
      const result = { status: 200, body: undefined as unknown, headers: new Headers() };
      const res = {
        setHeader(name: string, value: string) { result.headers.set(name, value); },
        status(status: number) { result.status = status; return res; },
        json(value: unknown) { result.body = value; result.headers.set("Content-Type", "application/json"); resolve(result); return res; },
        end() { resolve(result); return res; },
      } as unknown as Response;
      function run(index: number, error?: unknown): void {
        const handler = handlers[index];
        if (!handler) { reject(error ?? new Error("No response from MCP route")); return; }
        if ((handler.length === 4) !== (error !== undefined)) { run(index + 1, error); return; }
        const next: NextFunction = (nextError?: unknown) => run(index + 1, nextError);
        try {
          const handled = handler.length === 4
            ? (handler as ErrorRequestHandler)(error, req, res, next)
            : (handler as RequestHandler)(req, res, next);
          Promise.resolve(handled).catch(reject);
        } catch (caught) { reject(caught); }
      }
      run(0);
    });
  }
  return { post };
}

describe("hosted MCP HTTP security boundary (socket-free)", () => {
  it("allows each configured origin and server-to-server requests without Origin", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
    const { post } = boot({ VOICE_FLEET_MCP_ALLOWED_ORIGINS: " https://bot.example, ,http://localhost:3000 " });
    for (const origin of ["https://bot.example", "http://localhost:3000", undefined]) {
      const headers: Record<string, string> = origin === undefined ? {} : { Origin: origin };
      expect(await post(tool, headers)).toMatchObject({ status: 200, body: { result: { isError: false } } });
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ DOMAIN: "https://fleet.example:8443/app?query=1#fragment" }, "https://fleet.example:8443"],
    [{ DOMAIN: "fleet.example" }, "https://fleet.example"],
    [{ REPLIT_DOMAINS: "workspace.replit.dev, published.replit.app", REPLIT_DEV_DOMAIN: "workspace.replit.dev", REPLIT_DEPLOYMENT: "1" }, "https://published.replit.app"],
    [{ REPLIT_DEV_DOMAIN: "workspace.replit.dev" }, "https://workspace.replit.dev"],
  ] as const)("adds the app's configured public origin: %j", async (env, origin) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
    const { post } = boot(env);
    expect(await post(tool, { Origin: origin })).toMatchObject({ status: 200, body: { result: { isError: false } } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects unlisted origins before parsing or dispatch, ignoring host and forwarding headers", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected downstream fetch"));
    const { post } = boot({ VOICE_FLEET_MCP_ALLOWED_ORIGINS: "https://bot.example", DOMAIN: "fleet.example" });
    for (const Origin of ["https://evil.example", "https://bot.example.evil.test", "http://bot.example", "https://bot.example:8443", "https://bot.example/path", "null", ""]) {
      for (const payload of [tool, "{"]) {
        const result = await post(payload, { Origin, Host: "evil.example", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https" });
        expect(result).toMatchObject({ status: 403, body: { error: "Origin not allowed" } });
        expect(result.headers.get("content-type")).toContain("application/json");
      }
    }
    expect(await post(tool, { Origin: "https://evil.example", Authorization: "Bearer invalid" }))
      .toMatchObject({ status: 403, body: { error: "Origin not allowed" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not infer an allowed origin from localhost or an invalid domain", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected downstream fetch"));
    for (const env of [{}, { DOMAIN: "https://" }, { DOMAIN: "file:///tmp/app" }]) {
      const { post } = boot(env);
      for (const Origin of ["https://localhost:8000", "null"]) expect((await post(tool, { Origin })).status).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed envelopes with id null and zero downstream fetches, including batch members", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected downstream fetch"));
    const { post } = boot();
    const invalid = [
      null, true, 123, '"message"', {}, { id: 1 },
      { ...tool, jsonrpc: undefined }, { ...tool, jsonrpc: "1.0" }, { ...tool, jsonrpc: 2 },
      ...[null, false, {}, []].map((id) => ({ ...tool, id })),
      ...[undefined, null, 3, {}, []].map((method) => ({ ...tool, method })),
      { jsonrpc: "2.0", method: 3 }, { ...tool, jsonrpc: "1.0", id: undefined },
      { jsonrpc: "1.0", id: 1, result: {} }, { jsonrpc: "2.0", method: null, result: {} },
    ];
    for (const payload of invalid) {
      expect(await post(payload)).toMatchObject({ status: 400, body: invalidRequest });
      // A JSON string payload must stay a string when embedded in a batch.
      const item = typeof payload === "string" ? JSON.parse(payload) : payload;
      expect(await post([item])).toMatchObject({ status: 200, body: [invalidRequest] });
    }
    expect(await post([])).toMatchObject({ status: 400, body: invalidRequest });
    expect(await post([[]])).toMatchObject({ status: 200, body: [invalidRequest] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects batches over 20 entries before dispatch and accepts exactly 20", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
    const { post } = boot();
    const pings = Array.from({ length: 20 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ping" }));
    for (const batch of [[tool, ...pings], [...pings, tool], Array(21).fill({ jsonrpc: "2.0", method: "notifications/initialized" })]) {
      const response = await post(batch);
      expect(response).toMatchObject({ status: 400, body: {
        jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch too large (max 20)" },
      } });
      expect(response.headers.get("content-type")).toContain("application/json");
    }
    expect(fetch).not.toHaveBeenCalled();
    const accepted = await post([tool, ...pings.slice(1)]);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toHaveLength(20);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects notification methods carrying ids, echoing the id in single and batch replies", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { post } = boot();
    for (const method of ["notifications/initialized", "notifications/custom"]) {
      for (const id of ["notification", "", 0, -1, 1.5]) {
        const payload = { ...tool, method, id };
        const error = { ...invalidRequest, id };
        expect(await post(payload)).toMatchObject({ status: 400, body: error });
        expect(await post([payload, { jsonrpc: "2.0", id: "ping", method: "ping" }]))
          .toMatchObject({ status: 200, body: [error, { id: "ping", result: {} }] });
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects overflowing numeric ids from raw JSON with id null before dispatch", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { post } = boot();
    for (const id of ["1e400", "-1e400", "null", "false", "{}", "[]"]) {
      for (const method of ["tools/call", "notifications/custom"]) {
        const payload = `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":{"name":"voice_fleet_health"}}`;
        expect(await post(payload)).toMatchObject({ status: 400, body: invalidRequest });
        expect(await post(`[${payload}]`)).toMatchObject({ status: 200, body: [invalidRequest] });
      }
    }
    expect(fetch).not.toHaveBeenCalled();
    for (const id of ["", "request", 0, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1e-200]) {
      const response = await post({ jsonrpc: "2.0", id, method: "ping" });
      expect(JSON.parse(JSON.stringify(response.body))).toEqual({ jsonrpc: "2.0", id, result: {} });
    }
  });

  it("masks international phones in hosted operator fields and included content", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      from: "+44 20 7946 0000", note: "+44-20-7946-0001", body: "Call +442079460002 or +1 (909) 555-0113",
    }));
    const { post } = boot();
    for (const includeContent of [false, true]) {
      const response = await post({ ...tool, params: {
        name: "voice_fleet_operator_inbound_get", arguments: { callSid: "CA" + "a".repeat(32), includeContent },
      } });
      const result = (response.body as { result: { content: Array<{ text: string }> } }).result;
      expect(JSON.parse(result.content[0].text).data).toEqual({
        from: "***-***-0000", note: "***-***-0001",
        body: includeContent ? "Call ***-***-0002 or ***-***-0113" : "[redacted 39 chars]",
      });
    }
  });

  it("rejects method/result/error mixtures without downstream fetches, including notifications and batch members", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected downstream fetch"));
    const { post } = boot();
    for (const fields of [{ result: null }, { result: false }, { error: null }, { error: {} }, { result: {}, error: {} }]) {
      for (const request of [tool, { jsonrpc: "2.0", method: "notifications/initialized" }]) {
        const payload = { ...request, ...fields };
        expect(await post(payload)).toMatchObject({ status: 400, body: invalidRequest });
        expect(await post([payload, { jsonrpc: "2.0", id: "ping", method: "ping" }]))
          .toMatchObject({ status: 200, body: [invalidRequest, { id: "ping", result: {} }] });
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["tools/call", "initialize", "ping", "tools/list", "unknown"])("rejects id-less %s without downstream fetches", async (method) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected downstream fetch"));
    const { post } = boot();
    const payload = { jsonrpc: "2.0", method, params: tool.params };
    expect(await post(payload)).toMatchObject({ status: 400, body: invalidRequest });
    expect(await post([payload])).toMatchObject({ status: 200, body: [invalidRequest] });
    expect(await post([payload, { jsonrpc: "2.0", id: "ping", method: "ping" }]))
      .toMatchObject({ status: 200, body: [invalidRequest, { id: "ping", result: {} }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed client responses without downstream fetches", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected downstream fetch"));
    const { post } = boot();
    const invalid = [
      { jsonrpc: "2.0", id: 0 },
      { jsonrpc: "2.0", id: "both", result: null, error: null },
      { jsonrpc: "2.0", id: 0, result: {}, error: { code: -32603, message: "Synthetic error" } },
      ...[undefined, null, true, false, {}, [], Infinity].flatMap((id) => [
        { jsonrpc: "2.0", id, result: null },
        { jsonrpc: "2.0", id, error: { code: -32603, message: "Synthetic error" } },
      ]),
    ];
    for (const payload of invalid) {
      expect(await post(payload)).toMatchObject({ status: 400, body: invalidRequest });
      expect(await post([payload])).toMatchObject({ status: 200, body: [invalidRequest] });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores valid responses and notifications without downstream fetches", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected downstream fetch"));
    const { post } = boot();
    const ignored = [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/custom", params: tool.params },
      ...["", "response", 0, -1, 1.5].flatMap((id) => [
        { jsonrpc: "2.0", id, result: null },
        { jsonrpc: "2.0", id, error: { code: -32603, message: "Synthetic error" } },
      ]),
    ];
    for (const payload of [...ignored, ignored]) expect(await post(payload)).toMatchObject({ status: 202, body: undefined });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "2025-06-18", "2025-03-26", "2024-11-05"])("executes only the first tools/call per POST with protocol %s, retaining other methods and reply order", async (version) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
    const { post } = boot();
    const headers: Record<string, string> = version === undefined ? {} : { "MCP-Protocol-Version": version };
    const write = { ...tool, id: "first", params: { name: "voice_fleet_live_call_end", arguments: { sessionId: "synthetic" } } };
    const response = await post([
      { jsonrpc: "2.0", id: "init", method: "initialize" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      write,
      { jsonrpc: "2.0", id: "client-response", result: null },
      { jsonrpc: "2.0", id: "ping", method: "ping" },
      { ...tool, id: 0 },
      { jsonrpc: "2.0", id: "list", method: "tools/list" },
      { ...write, id: "" },
    ], headers);
    expect(response.status).toBe(200);
    expect((response.body as Array<{ id: unknown }>).map((reply) => reply.id)).toEqual(["init", "first", "ping", 0, "list", ""]);
    expect(response.body).toMatchObject([
      { result: { serverInfo: { name: "voice-fleet-mcp" } } },
      { result: { isError: false } },
      { result: {} },
      { id: 0, error: { code: -32600, message: "Send one tools/call per request" } },
      { result: { tools: expect.any(Array) } },
      { id: "", error: { code: -32600, message: "Send one tools/call per request" } },
    ]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:5000/api/plugin/v1/live_calls/synthetic/end", expect.objectContaining({ method: "POST" }));

    // The limit belongs to this POST, not the caller or a persistent session.
    expect(await post(tool, headers)).toMatchObject({ status: 200, body: { result: { isError: false } } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not execute later tools/call items even when the first fails local validation", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected downstream fetch"));
    const { post } = boot();
    expect(await post([{ ...tool, params: { name: "unknown" } }, { ...tool, id: "second" }]))
      .toMatchObject({ status: 200, body: [
        { id: 1, error: { code: -32602 } },
        { id: "second", error: { code: -32600, message: "Send one tools/call per request" } },
      ] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("dispatches only valid requests in a mixed batch, preserving reply order and string or numeric ids", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
    const { post } = boot();
    const response = await post([
      { ...tool, id: null }, { ...tool, id: "" }, { ...tool, id: undefined },
      { jsonrpc: "2.0", id: 5, result: {} }, { ...tool, id: 0 }, {},
    ]);
    expect(response.status).toBe(200);
    expect((response.body as Array<{ id: unknown }>).map((reply) => reply.id)).toEqual([null, "", null, 0, null]);
    expect(response.body).toMatchObject([
      invalidRequest, { result: { isError: false } }, invalidRequest,
      { id: 0, error: { code: -32600, message: "Send one tools/call per request" } }, invalidRequest,
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
