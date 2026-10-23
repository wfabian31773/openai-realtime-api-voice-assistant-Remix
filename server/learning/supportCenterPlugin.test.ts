import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SUPPORT_PROVENANCE_SQL } from "./definitions";
import { computeRemix, type Sources } from "./compute";
import { isReadFailure } from "./runner";
import {
  PLUGIN_FILING_PATH,
  PLUGIN_MAX_CALL_SIDS,
  supportCenterPluginBase,
  supportCenterPluginQuery,
} from "./supportCenterPlugin";

const SID_A = "CA" + "a".repeat(32);
const SID_B = "CA" + "b".repeat(32);
const ENV = { LEARNING_SUPPORT_CENTER_TOKEN: "tok-123", LEARNING_SUPPORT_CENTER_URL: "https://support.example/" } as NodeJS.ProcessEnv;

function okFetch(calls: unknown[]) {
  return vi.fn(async () => new Response(JSON.stringify({ calls }), { status: 200 })) as unknown as typeof fetch & { mock: any };
}

describe("the Support Center plugin adapter", () => {
  it("is absent without a token or a base URL, never a query that fails", () => {
    expect(supportCenterPluginQuery({ LEARNING_SUPPORT_CENTER_URL: "https://x" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(supportCenterPluginQuery({ LEARNING_SUPPORT_CENTER_TOKEN: "t" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(supportCenterPluginQuery({ LEARNING_SUPPORT_CENTER_TOKEN: "  ", LEARNING_SUPPORT_CENTER_URL: "https://x" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("falls back to the direct-to-app base and never to TICKETING_SYSTEM_URL (it can be n8n)", () => {
    expect(supportCenterPluginBase({ TICKETING_ENRICHMENT_URL: "https://app.example//" } as NodeJS.ProcessEnv)).toBe("https://app.example");
    expect(supportCenterPluginBase({ TICKETING_SYSTEM_URL: "https://n8n.example" } as NodeJS.ProcessEnv)).toBe("");
    expect(
      supportCenterPluginBase({ LEARNING_SUPPORT_CENTER_URL: "https://a", TICKETING_ENRICHMENT_URL: "https://b" } as NodeJS.ProcessEnv),
    ).toBe("https://a");
  });

  it("POSTs the SIDs with the bearer token to the filing route and maps the answer to the SQL row shape", async () => {
    const f = okFetch([
      { callSid: SID_A, anyAgent: true, anyUnknown: false },
      { callSid: SID_B, anyAgent: "true", anyUnknown: 1 },
    ]);
    const q = supportCenterPluginQuery(ENV, f)!;
    const res = await q(SUPPORT_PROVENANCE_SQL, [[SID_A, SID_B]]);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://support.example${PLUGIN_FILING_PATH}`);
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer tok-123");
    expect(JSON.parse(init.body)).toEqual({ callSids: [SID_A, SID_B] });
    // Only a real `true` counts; a truthy string or number is not an agent filing.
    expect(res.rows).toEqual([
      { call_sid: SID_A, any_agent: true, any_unknown: false },
      { call_sid: SID_B, any_agent: false, any_unknown: false },
    ]);
  });

  it("does not call the route for an empty list (it refuses one)", async () => {
    const f = okFetch([]);
    expect((await supportCenterPluginQuery(ENV, f)!(SUPPORT_PROVENANCE_SQL, [[]])).rows).toEqual([]);
    expect(f.mock.calls).toHaveLength(0);
  });

  it("refuses any SQL but the provenance read", async () => {
    await expect(supportCenterPluginQuery(ENV, okFetch([]))!("SELECT 1", [[SID_A]])).rejects.toThrow(/only the provenance read/);
  });

  it("refuses more SIDs than the route accepts, and compute never sends more", async () => {
    const many = Array.from({ length: PLUGIN_MAX_CALL_SIDS + 1 }, () => SID_A);
    await expect(supportCenterPluginQuery(ENV, okFetch([]))!(SUPPORT_PROVENANCE_SQL, [many])).rejects.toThrow(/more than/);
    const src = fs.readFileSync(path.join(__dirname, "compute.ts"), "utf8");
    expect(src).toMatch(new RegExp(`const SID_CHUNK = ${PLUGIN_MAX_CALL_SIDS};`));
  });

  it("a non-200 or a malformed answer throws, and names the status but not the body", async () => {
    const f401 = vi.fn(async () => new Response("secret body", { status: 401 })) as unknown as typeof fetch;
    const err = await supportCenterPluginQuery(ENV, f401)!(SUPPORT_PROVENANCE_SQL, [[SID_A]]).catch((e) => e as Error);
    expect((err as Error).message).toBe("plugin answered HTTP 401");
    const bad = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await expect(supportCenterPluginQuery(ENV, bad)!(SUPPORT_PROVENANCE_SQL, [[SID_A]])).rejects.toThrow(/no calls list/);
  });

  it("through compute: a plugin failure is a read failure (the night retries), unconfigured is not", async () => {
    const hub = async () => ({ rows: [{ call_sid: SID_A, lane: "tech", runtime_marker: "", filed: true }] });
    const base: Sources = { hub, hubHasRuntimeMarker: false };
    const failing = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const r1 = await computeRemix("2026-10-20", { ...base, supportCenter: supportCenterPluginQuery(ENV, failing) });
    expect(isReadFailure(r1.unavailable["remix.filed_rate_independent"])).toBe(true);
    const r2 = await computeRemix("2026-10-20", { ...base, supportCenter: supportCenterPluginQuery({} as NodeJS.ProcessEnv) });
    expect(isReadFailure(r2.unavailable["remix.filed_rate_independent"])).toBe(false);
    const ok = okFetch([{ callSid: SID_A, anyAgent: true, anyUnknown: false }]);
    const r3 = await computeRemix("2026-10-20", { ...base, supportCenter: supportCenterPluginQuery(ENV, ok) });
    expect(r3.values.find((v) => v.metricId === "remix.filed_rate_independent")).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it("production wires the plugin adapter, and no Support Center database login remains", () => {
    const src = fs.readFileSync(path.join(__dirname, "scheduler.ts"), "utf8");
    expect(src).toContain("supportCenter: supportCenterPluginQuery(env),");
    expect(src).not.toMatch(/LEARNING_SUPPORT_CENTER_DATABASE_URL|from "pg"/);
  });
});
