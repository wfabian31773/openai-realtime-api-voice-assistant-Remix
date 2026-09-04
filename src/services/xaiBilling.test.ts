/**
 * The parsing, the refusals, and the request shape.
 *
 * The request shape is pinned because xAI's schema is easy to get subtly
 * wrong — `values` takes objects with an aggregation, not bare strings, and
 * `timeUnit` is the prefixed enum. A wrong body returns a 400, which this
 * module correctly turns into "could not read", so the failure would look
 * like an outage rather than a bug.
 */
import { describe, it, expect } from "vitest";
import {
  readXaiBillingConfig,
  buildDailyUsageRequest,
  sumDailyUsage,
  fetchDailySpend,
  type FetchLike,
} from "./xaiBilling";

const SETUP = {
  configured: true as const,
  config: { baseUrl: "https://management-api.x.ai", managementKey: "mk-test", teamId: "team-1" },
};

const respond = (status: number, body: unknown): FetchLike =>
  async () => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

describe("configuration", () => {
  it("names BOTH missing variables, not just the first", () => {
    const setup = readXaiBillingConfig({});
    expect(setup.configured).toBe(false);
    if (!setup.configured) expect(setup.missing).toEqual(["XAI_MANAGEMENT_KEY", "XAI_TEAM_ID"]);
  });

  /**
   * The trap worth pinning: XAI_API_KEY is already set in this deployment and
   * cannot read billing. Having it must not make this look configured.
   */
  it("is NOT satisfied by the inference key that already exists", () => {
    // The team id is supplied, so ONLY the key question is under test — an
    // earlier version of this passed because teamId was missing too, and
    // would have let XAI_API_KEY quietly stand in for the management key.
    expect(
      readXaiBillingConfig({ XAI_API_KEY: "xai-live-key", XAI_TEAM_ID: "team-1" }).configured,
    ).toBe(false);
  });

  it("treats whitespace as unset", () => {
    expect(readXaiBillingConfig({ XAI_MANAGEMENT_KEY: "   ", XAI_TEAM_ID: "t" }).configured).toBe(false);
  });

  it("defaults to the management host, which is not the inference host", () => {
    const setup = readXaiBillingConfig({ XAI_MANAGEMENT_KEY: "k", XAI_TEAM_ID: "t" });
    expect(setup.configured).toBe(true);
    if (setup.configured) {
      expect(setup.config.baseUrl).toBe("https://management-api.x.ai");
      expect(setup.config.baseUrl).not.toContain("//api.x.ai");
    }
  });

  it("strips a trailing slash so the path does not double up", () => {
    const setup = readXaiBillingConfig({
      XAI_MANAGEMENT_KEY: "k", XAI_TEAM_ID: "t",
      XAI_MANAGEMENT_BASE_URL: "https://example.test/",
    });
    if (setup.configured) expect(setup.config.baseUrl).toBe("https://example.test");
  });
});

describe("the request xAI actually accepts", () => {
  it("uses the prefixed enum and an aggregation object, not the shorthand", () => {
    const body = buildDailyUsageRequest("2026-09-03") as any;
    expect(body.analyticsRequest.timeUnit).toBe("TIME_UNIT_DAY");
    expect(body.analyticsRequest.values).toEqual([{ name: "usd", aggregation: "AGGREGATION_SUM" }]);
    expect(body.analyticsRequest.groupBy).toEqual(["description"]);
  });

  it("covers the whole day", () => {
    const body = buildDailyUsageRequest("2026-09-03") as any;
    expect(body.analyticsRequest.timeRange.startTime).toBe("2026-09-03 00:00:00");
    expect(body.analyticsRequest.timeRange.endTime).toBe("2026-09-03 23:59:59");
    expect(body.analyticsRequest.timeRange.timezone).toBe("UTC");
  });
});

describe("reading a day's spend out of the response", () => {
  it("sums every point of every series", () => {
    const out = sumDailyUsage("2026-09-03", {
      timeSeries: [
        { groupLabels: ["grok-voice-think-fast-2.0"], dataPoints: [{ values: [30.5] }, { values: [3.18] }] },
        { groupLabels: ["grok-4"], dataPoints: [{ values: [1.0] }] },
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.totalUsd).toBeCloseTo(34.68, 6);
      expect(out.value.lines).toHaveLength(2);
    }
  });

  /**
   * A truncated series is not a total. Summing it would hand the reconciler a
   * number that is quietly too small and it would allocate every call low.
   */
  it("REFUSES a truncated series rather than under-reporting", () => {
    const out = sumDailyUsage("2026-09-03", {
      limitReached: true,
      timeSeries: [{ groupLabels: ["x"], dataPoints: [{ values: [1] }] }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("too low");
  });

  it("refuses a response with no series at all instead of calling it zero", () => {
    expect(sumDailyUsage("2026-09-03", {}).ok).toBe(false);
    expect(sumDailyUsage("2026-09-03", null).ok).toBe(false);
  });

  it("ignores a non-numeric value rather than turning the total into NaN", () => {
    const out = sumDailyUsage("2026-09-03", {
      timeSeries: [{ groupLabels: ["m"], dataPoints: [{ values: [2] }, { values: [null as any] }] }],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.totalUsd).toBe(2);
  });

  it("labels an ungrouped series rather than dropping it", () => {
    const out = sumDailyUsage("2026-09-03", { timeSeries: [{ dataPoints: [{ values: [5] }] }] });
    if (out.ok) expect(out.value.lines[0].description).toBe("(ungrouped)");
  });
});

describe("fetching, and every way it can decline", () => {
  it("says which variables to set, and that the inference key will not do", async () => {
    const out = await fetchDailySpend("2026-09-03", { setup: { configured: false, missing: ["XAI_TEAM_ID"] } });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("XAI_TEAM_ID");
      expect(out.reason).toContain("Management Keys");
      expect(out.reason).toContain("NOT the same credential");
    }
  });

  it("sends the bearer token to the team's usage path", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const spy: FetchLike = async (url, init) => {
      seenUrl = url;
      seenAuth = init?.headers?.Authorization ?? "";
      return { ok: true, status: 200, text: async () => JSON.stringify({ timeSeries: [] }) };
    };
    await fetchDailySpend("2026-09-03", { setup: SETUP, fetchImpl: spy });
    expect(seenUrl).toBe("https://management-api.x.ai/v1/billing/teams/team-1/usage");
    expect(seenAuth).toBe("Bearer mk-test");
  });

  /** A billing error body can echo account details; only the status travels. */
  it("reports the status of a rejection and never its body", async () => {
    const out = await fetchDailySpend("2026-09-03", {
      setup: SETUP,
      fetchImpl: respond(403, { error: "team acct-99887766 is not authorized" }),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("403");
      expect(out.reason).not.toContain("acct-99887766");
    }
  });

  it("does not throw when the network is down", async () => {
    const out = await fetchDailySpend("2026-09-03", {
      setup: SETUP,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("unreachable");
  });

  it("does not throw on a body that is not JSON", async () => {
    const out = await fetchDailySpend("2026-09-03", {
      setup: SETUP,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>gateway</html>" }),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("not JSON");
  });
});
