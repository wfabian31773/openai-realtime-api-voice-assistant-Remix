/**
 * v273: the provider_usage_summary writer keeps the call_events discipline
 * every teardown writer keeps: emit first, wait for the predecessor before
 * flushing, release only on a flush that landed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderUsageSummary } from "./tokenUsage";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";

const log = vi.hoisted(() => ({
  order: [] as string[],
  emitted: [] as unknown[][],
  released: [] as Array<string | undefined>,
  flushOk: [] as boolean[],
}));
vi.mock("../services/callEventLog", () => ({
  emitCallEvent: (...a: unknown[]) => {
    log.order.push("emit");
    log.emitted.push(a);
  },
  flushCallEvents: async () => {
    log.order.push("flush");
    return log.flushOk.length ? (log.flushOk.shift() as boolean) : true;
  },
  releaseCallEvents: (id?: string) => {
    log.order.push("release");
    log.released.push(id);
  },
}));

const { logProviderUsage, PROVIDER_USAGE_EVENT } = await import("./providerUsageTelemetry");

const SID = "CA00000000000000000000000000000273";
const SUMMARY: ProviderUsageSummary = {
  responses: 2,
  statuses: { completed: 2 },
  statusReasons: {},
  inputTokens: 240,
  outputTokens: 22,
  totalTokens: 262,
  outputAudioSeconds: 3.75,
  billableAudioSeconds: 3,
  lastResponseId: "resp_b",
};

beforeEach(() => {
  log.order.length = 0;
  log.emitted.length = 0;
  log.released.length = 0;
  log.flushOk.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("logProviderUsage", () => {
  it("emits the row, then flushes and releases", async () => {
    const ok = await logProviderUsage({ callSid: SID, outcome: "caller_hangup" }, SUMMARY, { callLogId: "row-1" });
    expect(ok).toBe(true);
    expect(log.order).toEqual(["emit", "flush", "release"]);
    const [callId, level, category, message, data] = log.emitted[0];
    expect([callId, level, category, message]).toEqual([SID, "info", "model", PROVIDER_USAGE_EVENT]);
    expect(data).toMatchObject({ responses: 2, billableAudioSeconds: 3, outcome: "caller_hangup" });
  });

  it("releases only once a flush lands, and leaves a failed one for the reaper", async () => {
    log.flushOk.push(false, false, false);
    const ok = await logProviderUsage({ callSid: SID, outcome: "caller_hangup" }, SUMMARY, {}, {
      backoffMs: [1, 1],
      sleep: async () => {},
    });
    expect(ok).toBe(false);
    expect(log.order).toEqual(["emit", "flush", "flush", "flush"]);
    expect(log.released).toEqual([]);
  });

  it("retries a failed flush and releases when the retry lands", async () => {
    log.flushOk.push(false);
    const ok = await logProviderUsage({ callSid: SID, outcome: "caller_hangup" }, SUMMARY, {}, {
      backoffMs: [1],
      sleep: async () => {},
    });
    expect(ok).toBe(true);
    expect(log.order).toEqual(["emit", "flush", "flush", "release"]);
  });

  it("emits before its predecessor finishes and flushes only after it", async () => {
    let finish!: () => void;
    const after = new Promise<void>((r) => (finish = r)).then(() => void log.order.push("predecessor"));
    const done = logProviderUsage({ callSid: SID, outcome: "caller_hangup" }, SUMMARY, {}, { after });
    await new Promise((r) => setTimeout(r, 5));
    expect(log.order).toEqual(["emit"]);
    finish();
    await done;
    expect(log.order).toEqual(["emit", "predecessor", "flush", "release"]);
  });

  it("writes nothing for a call that finished no response, and still waits for the predecessor", async () => {
    let waited = false;
    const after = Promise.resolve().then(() => void (waited = true));
    expect(await logProviderUsage({ callSid: SID, outcome: "caller_hangup" }, undefined, {}, { after })).toBe(false);
    expect(waited).toBe(true);
    expect(log.order).toEqual([]);
  });
});
