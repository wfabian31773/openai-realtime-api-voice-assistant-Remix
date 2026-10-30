import { describe, expect, it, vi } from "vitest";
import type { Express, RequestHandler } from "express";
import { MemoryPluginStore } from "../src/plugin/store";
import { mountOperatorLineSettings } from "./operatorLineSettings";
import { requireAuth, requireRole } from "./auth";

vi.mock("./db", () => ({ db: {} }));

function boot(environmentEnabled = "true") {
  const store = new MemoryPluginStore();
  const routes: Record<string, RequestHandler[]> = {};
  const app = { get: (path: string, ...handlers: RequestHandler[]) => { routes[`GET ${path}`] = handlers; },
    put: (path: string, ...handlers: RequestHandler[]) => { routes[`PUT ${path}`] = handlers; } } as unknown as Express;
  mountOperatorLineSettings(app, { store: () => store, env: { OPERATOR_LINE_INBOUND_ENABLED: environmentEnabled },
    authenticate: requireAuth, admin: requireRole("admin") });
  async function request(method: string, role?: string, body?: unknown, path = "/api/settings/operator-line", bearer?: string) {
    const req = { session: role ? { userId: "staff-id", userRole: role } : {}, body,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {} };
    const result = { status: 200, body: undefined as any, headers: new Headers() };
    const res = { status(code: number) { result.status = code; return res; }, json(value: unknown) { result.body = value; return res; },
      setHeader(name: string, value: string) { result.headers.set(name, value); } };
    async function run(index: number): Promise<void> {
      const handler = routes[`${method} ${path}`][index];
      if (!handler) return;
      let next: Promise<void> | undefined;
      await handler(req as never, res as never, () => { next = run(index + 1); });
      await next;
    }
    await run(0);
    return result;
  }
  return { store, request };
}

describe("staff operator line setting with existing session/role permissions", () => {
  it("requires staff authentication to read and the existing admin role to write", async () => {
    const h = boot();
    expect((await h.request("GET")).status).toBe(401);
    expect((await h.request("PUT", undefined, { enabled: false })).status).toBe(401);
    for (const role of ["user", "manager"]) {
      expect((await h.request("GET", role)).body).toMatchObject({ effectiveEnabled: true });
      expect((await h.request("PUT", role, { enabled: false })).status).toBe(403);
    }
    expect(await h.store.getOperatorLineEnabled()).toBe(true);
    expect((await h.request("PUT", "admin", { enabled: false })).body).toMatchObject({ enabled: false, effectiveEnabled: false });
    const read = await h.request("GET", "user");
    expect(read.body.enabled).toBe(false);
    expect(read.headers.get("Cache-Control")).toBe("no-store");
  });

  it("cannot override the env hard off", async () => {
    const h = boot("false");
    expect((await h.request("PUT", "admin", { enabled: true })).body).toEqual({ enabled: true, environmentEnabled: false, effectiveEnabled: false });
  });

  it.each([undefined, null, "false", 0])("rejects invalid enabled values (%s)", async (enabled) => {
    const h = boot();
    expect((await h.request("PUT", "admin", { enabled })).status).toBe(400);
    expect(await h.store.getOperatorLineEnabled()).toBe(true);
  });

  it("fails closed when settings storage fails", async () => {
    const h = boot();
    vi.spyOn(h.store, "getOperatorLineEnabled").mockRejectedValue(new Error("private"));
    expect((await h.request("GET", "user")).status).toBe(503);
    vi.spyOn(h.store, "setOperatorLineEnabled").mockRejectedValue(new Error("private"));
    expect((await h.request("PUT", "admin", { enabled: false })).status).toBe(503);
  });
});

describe("staff operator scenario pre-approval setting", () => {
  const path = "/api/settings/operator-scenario-preapproval";

  it("defaults OFF and only the existing admin session role can flip it", async () => {
    const h = boot();
    expect((await h.request("GET", "user", undefined, path)).body).toEqual({ enabled: false });
    const bot = h.store.mint(["operator:call"]);
    expect((await h.request("PUT", undefined, { enabled: true }, path, bot.plaintext)).status).toBe(401);
    expect((await h.request("GET", undefined, undefined, path, bot.plaintext)).status).toBe(401);
    for (const role of [undefined, "user", "manager"]) {
      expect((await h.request("PUT", role, { enabled: true }, path)).status).toBe(role ? 403 : 401);
    }
    expect(await h.store.getOperatorScenarioPreapprovalEnabled()).toBe(false);
    const write = vi.spyOn(h.store, "setOperatorScenarioPreapprovalEnabled");
    expect((await h.request("PUT", "admin", { enabled: true }, path)).body).toEqual({ enabled: true });
    expect(write).toHaveBeenCalledWith(true, "staff-id");
    const read = await h.request("GET", "user", undefined, path);
    expect(read.body).toEqual({ enabled: true });
    expect(read.headers.get("Cache-Control")).toBe("no-store");
    expect((await h.request("PUT", "admin", { enabled: false }, path)).body).toEqual({ enabled: false });
  });

  it.each([undefined, null, "true", 1])("rejects invalid enabled values (%s)", async (enabled) => {
    const h = boot();
    expect((await h.request("PUT", "admin", { enabled }, path)).status).toBe(400);
    expect(await h.store.getOperatorScenarioPreapprovalEnabled()).toBe(false);
  });

  it("reports OFF when reading or writing the setting fails", async () => {
    const h = boot();
    await h.store.setOperatorScenarioPreapprovalEnabled(true, "staff-id");
    vi.spyOn(h.store, "getOperatorScenarioPreapprovalEnabled").mockRejectedValue(new Error("private"));
    expect(await h.request("GET", "user", undefined, path)).toMatchObject({ status: 503, body: { enabled: false } });
    vi.spyOn(h.store, "setOperatorScenarioPreapprovalEnabled").mockRejectedValue(new Error("private"));
    expect(await h.request("PUT", "admin", { enabled: false }, path)).toMatchObject({ status: 503, body: { enabled: false } });
  });
});
